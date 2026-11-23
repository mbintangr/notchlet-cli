import { readFile, readdir, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..');
const skillsRepoRoot = path.resolve(repositoryRoot, 'notchlet-skills');
const skillsSourceDir = path.join(skillsRepoRoot, 'skills');
const sourcePath = path.join(skillsSourceDir, 'notchlet-super', 'SKILL.md');
const source = await readFile(sourcePath, 'utf8');

const requiredCommands = [
  "command === 'init'", "command === 'doctor'", "command === 'workspace'", "command === 'sync'",
  "command === 'checkpoint'", "command === 'instructions'", "command === 'status'", "command === 'task'",
  "command === 'change'", "command === 'validate'", "command === 'backlog'", "command === 'evidence'",
];
const cliSource = await readFile(path.join(packageRoot, 'src', 'cli.ts'), 'utf8');
for (const command of requiredCommands) if (!cliSource.includes(command)) throw new Error(`Guidance references an unavailable CLI command: ${command}`);
for (const syntax of ['sync status|push|pull|resolve --change', 'checkpoint --change', 'evidence record --change', 'instructions <change-name|id> [--action plan|revise|implement|verify|resume]', 'change new <name>', 'change list', 'change show <name|id>', 'change convert <name|id>', 'status [change-name|id]', 'validate <change>', 'task start <task-name|id> --change <name|id> --revision <n>', 'task complete <task-name|id> --change <name|id> --revision <n>', 'backlog import <item-key|title|id>', 'mcp serve --server <url>', 'mcp status [--server <url>]', 'mcp disconnect [--client <agent>]', 'mcp revoke [--server <url>]']) {
  if (!cliSource.includes(syntax)) throw new Error(`Guidance syntax is not present in CLI help: ${syntax}`);
}
const mcpSkillSource = await readFile(path.join(skillsSourceDir, 'notchlet-mcp', 'SKILL.md'), 'utf8');
const mcpConfigSource = await readFile(path.join(packageRoot, 'src', 'mcp-config.ts'), 'utf8');
const mcpManagementSource = await readFile(path.join(packageRoot, 'src', 'mcp-management.ts'), 'utf8');
for (const scope of ['workspace:read', 'backlog:write', 'changes:write', 'documents:write', 'tickets:write', 'generation:run', 'issues:sync']) {
  if (!mcpManagementSource.includes(`'${scope}'`)) throw new Error(`Configured MCP scope is not present in CLI management: ${scope}`);
}
for (const shape of ['mcp.servers', 'mcpServers', "type: 'stdio'"]) {
  if (!mcpConfigSource.includes(shape)) throw new Error(`Guidance client config shape is not supported by the CLI: ${shape}`);
}
if (!mcpSkillSource.includes('notchlet init --interactive') || !mcpSkillSource.includes('notchlet mcp status') || /your-mcp-token|curl\s+[^\n]*\/mcp|pg\.mbintangr\.com\/mcp/i.test(mcpSkillSource)) {
  throw new Error('notchlet-mcp guidance must explain supported init/status setup without a static token, old hosted origin, or unauthenticated GET probe.');
}
const instructionsLine = source.split(/\r?\n/).find(line => line.includes('notchlet instructions') && line.includes('--action'));
if (!instructionsLine) throw new Error('Canonical guidance does not document the instructions action surface.');
for (const action of ['plan', 'revise', 'implement', 'verify', 'resume']) {
  if (!cliSource.includes(`'${action}'`)) throw new Error(`Guidance references an unsupported workflow action: ${action}`);
  if (!new RegExp(`\\b${action}\\b`).test(instructionsLine)) throw new Error(`Canonical guidance does not reference its declared workflow action: ${action}`);
}

const skillLock = JSON.parse(await readFile(path.join(skillsRepoRoot, 'skills-lock.json'), 'utf8'));
const aliases = JSON.parse(await readFile(path.join(packageRoot, 'guidance', 'aliases.json'), 'utf8'));
const requiredSkills = ['notchlet-mcp', 'notchlet-platform', 'notchlet-plan', 'notchlet-implement', 'notchlet-review', 'notchlet-deliver'];
for (const skill of requiredSkills) {
  if (!skillLock.skills?.[skill]) throw new Error(`Guidance references a skill missing from skills-lock.json: ${skill}`);
  if (!source.includes(`\`${skill}\``)) throw new Error(`Canonical guidance does not reference its declared skill: ${skill}`);
}
for (const [legacy, migration] of Object.entries(aliases.aliases ?? {})) {
  for (const skill of migration.skills ?? []) if (!skillLock.skills?.[skill]) throw new Error(`Alias ${legacy} maps to a skill missing from skills-lock.json: ${skill}`);
  for (const command of migration.commands ?? []) if (!cliSource.includes(command)) throw new Error(`Alias ${legacy} maps to an unsupported CLI command: ${command}`);
}

const toolRoot = path.resolve(repositoryRoot, 'notchlet', 'notchlet-be', 'src', 'mcp', 'tools');
const toolFiles = [
  path.join(toolRoot, 'lifecycle.tools.ts'),
  path.join(toolRoot, 'development.tools.ts'),
];
const toolSources = await Promise.all(toolFiles.map(file => readFile(file, 'utf8')));
const requiredTools = {
  backlog_development_context: ['itemId', 'section', 'cursor', 'knownFingerprint', 'limit'],
  development_changes_list: ['productId', 'limit', 'cursor'],
  development_change_get: ['changeId'],
  development_instructions_get: ['changeId', 'action', 'snapshotRevision', 'context'],
  development_delivery_create: ['changeId', 'expectedRevision', 'operationId', 'payloadHash', 'snapshotRevision', 'target', 'backlogStatus', 'repositoryRef', 'summary'],
};
for (const [name, args] of Object.entries(requiredTools)) {
  const toolLines = toolSources.flatMap(text => text.split(/\r?\n/));
  const nameIndex = toolLines.findIndex(line => line.includes(`name: '${name}'`));
  if (nameIndex < 0) throw new Error(`Guidance references an MCP tool not registered by the server: ${name}`);
  // The tool's schema may be prettier-wrapped across lines; its definition ends at the next registered tool.
  const nextNameIndex = toolLines.findIndex((line, index) => index > nameIndex && /name: '[a-z_]+'/.test(line));
  const definition = toolLines.slice(nameIndex, nextNameIndex < 0 ? undefined : nextNameIndex).join('\n');
  for (const arg of args) if (!definition.includes(arg)) throw new Error(`Guidance references unsupported ${name} argument: ${arg}`);
}
const developmentToolSource = toolSources[1];
for (const action of ['plan', 'revise', 'implement', 'verify', 'resume']) {
  if (!developmentToolSource.includes(`'${action}'`)) throw new Error(`Guidance references an unsupported development MCP action: ${action}`);
}

if (/notchlet-init|curl\s+[^\n]*\/mcp/i.test(source)) throw new Error('Canonical guidance contains a stale init or unauthenticated MCP GET assumption.');
if (!/## Capability mode/.test(source) || !/\*\*Connected\*\*[\s\S]*?\*\*Local\*\*[\s\S]*?\*\*Neither\*\*/.test(source)) throw new Error('Canonical guidance must declare the connected, local, and unavailable capability modes.');
for (const phase of ['Phase 1 — Plan & grill', 'Phase 2 — Create backlogs', 'Phase 3 — Implement', 'Phase 4 — Deliver', 'Phase 5 — Done']) {
  if (!source.includes(phase)) throw new Error(`Canonical guidance is missing its ${phase} phase.`);
}
for (const syntax of ['notchlet workspace bind', 'notchlet backlog import', 'notchlet change apply', 'notchlet verify <change> --record', 'notchlet sync status|push|pull --change', 'notchlet checkpoint --change']) {
  if (!source.includes(syntax)) throw new Error(`Canonical guidance does not document its CLI tracking command: ${syntax}`);
}
if (!/sync pending/.test(source)) throw new Error('Canonical guidance must defer platform-only steps in local mode as sync pending.');
if (!/Never push, open or merge a PR, deploy, or set DONE without explicit authorization/.test(source)) throw new Error('Canonical guidance must gate external side effects on explicit authorization.');

const clients = ['opencode', 'claude-code', 'agent'];
const skillDirs = await readdir(skillsSourceDir);
const skillEntries = [];
for (const dir of skillDirs) {
  const skillFile = path.join(skillsSourceDir, dir, 'SKILL.md');
  let st;
  try { st = await stat(skillFile); } catch { st = null; }
  if (!st || !st.isFile()) continue;
  const content = await readFile(skillFile, 'utf8');
  skillEntries.push({ name: dir, content, hash: createHash('sha256').update(content).digest('hex') });
}
// Use local guidance/notchlet-super.md as canonical source for notchlet-super skill
const localSuperSource = await readFile(sourcePath, 'utf8');
for (const entry of skillEntries) {
  if (entry.name === 'notchlet-super') {
    entry.content = localSuperSource;
    entry.hash = createHash('sha256').update(localSuperSource).digest('hex');
  }
}

// Concurrent generate-guidance runs (guidance and guidance-install test files) must never expose partial files.
// Windows can transiently lock the destination while another writer replaces it, so retry the rename.
async function writeAtomic(target, content) {
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 20) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

const targets = [];
for (const client of clients) {
  for (const entry of skillEntries) {
    const target = path.join(packageRoot, 'guidance', 'generated', client, entry.name, 'SKILL.md');
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, entry.content);
    targets.push({ client, path: path.relative(packageRoot, target).replace(/\\/g, '/'), sha256: entry.hash, skill: entry.name });
  }
}

const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const skillsMap = {};
for (const e of skillEntries) skillsMap[e.name] = { hash: e.hash, path: `skills/${e.name}/SKILL.md` };
const manifest = {
  manifestVersion: 1,
  source: 'skills/notchlet-super/SKILL.md',
  sourceVersion: packageManifest.version,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  skillsRepo: aliases.source,
  skillCount: skillEntries.length,
  skills: skillsMap,
  targets,
};
const manifestDir = path.join(packageRoot, 'guidance', 'generated');
await mkdir(manifestDir, { recursive: true });
await writeAtomic(path.join(manifestDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeAtomic(path.join(manifestDir, 'compatibility.json'), `${JSON.stringify({ skills: skillLock.skills, aliases: aliases.aliases, source: aliases.source }, null, 2)}\n`);
console.log(`Synced ${targets.length} skill outputs (${skillEntries.length} skills x ${clients.length} clients) from ${skillsRepoRoot} to guidance/generated/.`);
