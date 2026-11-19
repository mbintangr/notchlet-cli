import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GuidanceClient = 'opencode' | 'claude';
type ClientRecord = { target: string; sourceHash: string; installedHash: string; sourceVersion: string };
type InstallManifest = { manifestVersion: 1; clients: Partial<Record<GuidanceClient, ClientRecord>> };
type InstallOptions = { apply?: boolean };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetFor = (client: GuidanceClient) => client === 'opencode'
  ? '.opencode/skills/notchlet-super/SKILL.md'
  : '.claude/skills/notchlet-super/SKILL.md';

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

async function readManifest(file: string): Promise<InstallManifest> {
  const stat = await lstatOrNull(file);
  if (!stat) return { manifestVersion: 1, clients: {} };
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Client guidance manifest is not a regular file.');
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (parsed?.manifestVersion !== 1 || !parsed.clients || typeof parsed.clients !== 'object' || Array.isArray(parsed.clients)) throw new Error('Client guidance manifest is invalid; preserve it and reconcile manually.');
  return parsed as InstallManifest;
}

async function atomicWrite(file: string, contents: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: 'wx' });
  await rename(temporary, file).catch(async error => { await rm(temporary, { force: true }); throw error; });
}

/** Preview/apply one managed skill file without touching unrelated client configuration. */
export async function installClientGuidance(rootInput: string, client: GuidanceClient, options: InstallOptions = {}) {
  if (!['opencode', 'claude'].includes(client)) throw new Error('Client must be opencode or claude.');
  const root = path.resolve(rootInput), target = targetFor(client);
  const generated = path.join(packageRoot, 'guidance', 'generated', client === 'claude' ? 'claude-code' : 'opencode', 'notchlet-super', 'SKILL.md');
  const source = await readFile(generated, 'utf8'), sourceHash = hash(source);
  const manifestRelative = path.join('.notchlet', '.local', 'client-guidance.json');
  await assertSafeParents(root, manifestRelative);
  const manifestPath = path.join(root, manifestRelative);
  const manifest = await readManifest(manifestPath);
  const previous = manifest.clients[client];
  const currentStat = await assertSafeParents(root, target);
  const current = currentStat ? await readFile(path.join(root, target), 'utf8') : null;
  const currentHash = current === null ? null : hash(current);
  let action: 'install' | 'update' | 'unchanged' | 'conflict';
  let reason: string | undefined;
  if (current === null) action = 'install';
  else if (!previous || previous.target !== target) { action = 'conflict'; reason = 'An unmanaged file already exists at the target path.'; }
  else if (currentHash !== previous.installedHash) { action = 'conflict'; reason = 'The managed guidance file was modified locally; local content is preserved.'; }
  else if (currentHash === sourceHash) action = 'unchanged';
  else action = 'update';

  const result = { client, target, action, sourceHash, ...(reason ? { reason } : {}), applied: false };
  if (!options.apply || action === 'conflict' || action === 'unchanged') return result;

  await atomicWrite(path.join(root, target), source);
  manifest.clients[client] = { target, sourceHash, installedHash: sourceHash, sourceVersion: JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')).version };
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...result, applied: true };
}
