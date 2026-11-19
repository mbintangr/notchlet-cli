import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const sourcePath = path.join(packageRoot, 'guidance', 'notchlet-super.md');
const source = await readFile(sourcePath, 'utf8');

const requiredCommands = [
  "command === 'init'", "command === 'doctor'", "command === 'workspace'", "command === 'sync'",
  "command === 'checkpoint'", "command === 'instructions'", "command === 'status'", "command === 'task'",
  "command === 'change'", "command === 'validate'", "command === 'backlog'", "command === 'evidence'",
];
const cliSource = await readFile(path.join(packageRoot, 'src', 'cli.ts'), 'utf8');
for (const command of requiredCommands) if (!cliSource.includes(command)) throw new Error(`Guidance references an unavailable CLI command: ${command}`);
for (const syntax of ['sync status|push|pull|resolve --change', 'checkpoint --change', 'evidence record --change', 'instructions <change> [--action plan|revise|implement|verify|resume]', 'change new <name>', 'change list', 'change show <id>', 'change convert <id>', 'status [change]', 'validate <change>', 'task start <task-id> --change <id> --revision <n>', 'task complete <task-id> --change <id> --revision <n>', 'backlog import <item-id>']) {
  if (!cliSource.includes(syntax)) throw new Error(`Guidance syntax is not present in CLI help: ${syntax}`);
}
for (const action of ['plan', 'revise', 'implement', 'verify', 'resume']) {
  if (!cliSource.includes(`'${action}'`)) throw new Error(`Guidance references an unsupported workflow action: ${action}`);
  if (!source.includes(`--action ${action}`)) throw new Error(`Canonical guidance does not reference its declared workflow action: ${action}`);
}

const skillLock = JSON.parse(await readFile(path.join(repositoryRoot, 'skills-lock.json'), 'utf8'));
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

const toolFiles = [
  path.join(repositoryRoot, 'product-guy-be', 'src', 'mcp', 'tools', 'lifecycle.tools.ts'),
  path.join(repositoryRoot, 'product-guy-be', 'src', 'mcp', 'tools', 'development.tools.ts'),
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
  const definition = toolSources.flatMap(text => text.split(/\r?\n/)).find(line => line.includes(`name: '${name}'`));
  if (!definition) throw new Error(`Guidance references an MCP tool not registered by the server: ${name}`);
  for (const arg of args) if (!definition.includes(arg)) throw new Error(`Guidance references unsupported ${name} argument: ${arg}`);
  if (!source.includes(`\`${name}({`)) throw new Error(`Canonical guidance does not reference its declared MCP tool: ${name}`);
}
const developmentToolSource = toolSources[1];
for (const action of ['plan', 'revise', 'implement', 'verify', 'resume']) {
  if (!developmentToolSource.includes(`'${action}'`)) throw new Error(`Guidance references an unsupported development MCP action: ${action}`);
}

if (/notchlet-init|curl\s+[^\n]*\/mcp/i.test(source)) throw new Error('Canonical guidance contains a stale init or unauthenticated MCP GET assumption.');
if (!/Explore \/ investigate \(read-only\)[\s\S]*?Do not run `notchlet init`/.test(source)) throw new Error('Explore guidance must explicitly be read-only and avoid initialization.');
if (!/Plan only \(read-only unless asked to persist\)[\s\S]*?does not require initialization, an epic→story→task hierarchy, or application\/change-artifact writes/.test(source)) throw new Error('Planning guidance must be read-only by default and independent of initialization and backlog hierarchy.');
const targets = [
  path.join(packageRoot, 'guidance', 'generated', 'opencode', 'notchlet-super', 'SKILL.md'),
  path.join(packageRoot, 'guidance', 'generated', 'claude-code', 'notchlet-super', 'SKILL.md'),
];
const sourceHash = createHash('sha256').update(source).digest('hex');
const generated = [];
for (const target of targets) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source, 'utf8');
  generated.push({ client: target.includes(`${path.sep}opencode${path.sep}`) ? 'opencode' : 'claude-code', path: path.relative(packageRoot, target).replace(/\\/g, '/'), sha256: sourceHash });
}
const packageManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const manifest = { manifestVersion: 1, source: 'guidance/notchlet-super.md', sourceVersion: packageManifest.version, sourceSha256: sourceHash, targets: generated };
await writeFile(path.join(packageRoot, 'guidance', 'generated', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(path.join(packageRoot, 'guidance', 'generated', 'compatibility.json'), `${JSON.stringify({ skills: skillLock.skills, aliases: aliases.aliases, source: aliases.source }, null, 2)}\n`, 'utf8');
console.log(`Generated ${targets.length} state-aware notchlet-super outputs from ${path.relative(repositoryRoot, sourcePath)}.`);
