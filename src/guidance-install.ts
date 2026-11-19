import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GuidanceClient = 'opencode' | 'claude';
type ClientRecord = { target: string; sourceHash: string; installedHash: string; sourceVersion: string };
type SkillRecord = { skill: string; target: string; sourceHash: string; installedHash: string; sourceVersion: string };
type InstallOptions = { apply?: boolean };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..');
const skillsRepoRoot = path.resolve(repositoryRoot, 'notchlet-skills');
const skillsSourceDir = path.join(skillsRepoRoot, 'skills');
const targetFor = (client: GuidanceClient, skill: string) => client === 'opencode'
  ? `.opencode/skills/${skill}/SKILL.md`
  : `.claude/skills/${skill}/SKILL.md`;

async function lstatOrNull(file: string) {
  try { return await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function assertSafeParents(root: string, relative: string) {
  let current = root;
  for (const segment of path.dirname(relative).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error(`Guidance target traverses a non-directory or symlink: ${relative}`);
  }
  const target = await lstatOrNull(path.join(root, relative));
  if (target?.isSymbolicLink() || (target && !target.isFile())) throw new Error(`Guidance target is not a regular file: ${relative}`);
  return target;
}

async function readManifest(file: string): Promise<{ manifestVersion: number; clients: Record<string, Record<string, ClientRecord>>; skills: Record<string, SkillRecord> }> {
  const stat = await lstatOrNull(file);
  if (!stat) return { manifestVersion: 1, clients: {}, skills: {} };
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Client guidance manifest is not a regular file.');
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (parsed?.manifestVersion !== 1) throw new Error('Client guidance manifest is invalid; preserve it and reconcile manually.');
  return parsed;
}

async function atomicWrite(file: string, contents: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: 'wx' });
  await rename(temporary, file).catch(async error => { await rm(temporary, { force: true }); throw error; });
}

async function readSkillSource(skill: string): Promise<{ content: string; hash: string }> {
  const skillFile = path.join(skillsSourceDir, skill, 'SKILL.md');
  const st = await stat(skillFile).catch(() => null);
  if (!st?.isFile()) throw new Error(`Skill not found in notchlet-skills repo: ${skill}`);
  const content = await readFile(skillFile, 'utf8');
  return { content, hash: hash(content) };
}

export async function installClientGuidance(rootInput: string, client: GuidanceClient, options: InstallOptions = {}) {
  if (!['opencode', 'claude'].includes(client)) throw new Error('Client must be opencode or claude.');

  const skillDirs = await readdir(skillsSourceDir);
  const skills: string[] = [];
  for (const dir of skillDirs) {
    const st = await stat(path.join(skillsSourceDir, dir, 'SKILL.md')).catch(() => null);
    if (st?.isFile()) skills.push(dir);
  }

  const manifestRelative = path.join('.notchlet', '.local', 'client-guidance.json');
  await assertSafeParents(rootInput, manifestRelative);
  const manifestPath = path.join(rootInput, manifestRelative);
  const manifest = await readManifest(manifestPath);
  const clientSkills = manifest.clients[client] ?? {};
  const skillsInstalled = manifest.skills ?? {};

  const results: Array<{ skill: string; target: string; action: 'install' | 'update' | 'unchanged' | 'conflict'; applied: boolean; reason?: string }> = [];

  for (const skill of skills) {
    const { content: source, hash: sourceHash } = await readSkillSource(skill);
    const target = targetFor(client, skill);
    const previous = skillsInstalled[skill];
    const currentStat = await assertSafeParents(rootInput, target);
    const current = currentStat ? await readFile(path.join(rootInput, target), 'utf8') : null;
    const currentHash = current === null ? null : hash(current);
    let action: 'install' | 'update' | 'unchanged' | 'conflict';
    let reason: string | undefined;
    if (current === null) action = 'install';
    else if (!previous || previous.target !== target) { action = 'conflict'; reason = 'An unmanaged file already exists at the target path.'; }
    else if (currentHash !== previous.installedHash) { action = 'conflict'; reason = 'The managed guidance file was modified locally; local content is preserved.'; }
    else if (currentHash === sourceHash) action = 'unchanged';
    else action = 'update';

    const result = { skill, target, action, sourceHash, ...(reason ? { reason } : {}), applied: false };
    if (!options.apply || action === 'conflict' || action === 'unchanged') {
      results.push(result);
      continue;
    }

    await atomicWrite(path.join(rootInput, target), source);
    skillsInstalled[skill] = { skill, target, sourceHash, installedHash: sourceHash, sourceVersion: JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version };
    results.push({ ...result, applied: true });
  }

  manifest.clients[client] = clientSkills;
  manifest.skills = skillsInstalled;
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const anyApplied = results.some(r => r.applied);
  const appliedCount = results.filter(r => r.applied).length;
  return { client, action: 'install', applied: anyApplied, results, appliedCount, totalCount: results.length };
}
