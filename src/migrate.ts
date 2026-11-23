import { access, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteJson, composeNodeDirectory, readBacklogSidecar, readChange, scanChangeDirectories,
  validatePathSegment,
  type BacklogSidecar, type Change, type ChangeDirectoryEntry,
} from '@notchlet/core';

export interface MigrateOptions {
  apply?: boolean;
  rename?: boolean;
  legacyDir?: string;
}

export interface MigrateMove {
  from: string;
  to: string;
  action: 'move' | 'skip';
  reason?: string;
}

export interface MigrateResult {
  dryRun: boolean;
  legacyDir: string;
  rename: boolean;
  scanned: number;
  moves: MigrateMove[];
  moved: number;
  skipped: number;
  blocked: number;
  journal: string | null;
}

interface MigrateNode {
  entry: ChangeDirectoryEntry;
  id: string;
  change: Change | null;
  sidecar: BacklogSidecar | null;
  error?: string;
  leaf?: string;
  target?: string;
  blockedReason?: string;
}

async function pathExists(target: string): Promise<boolean> {
  try { await access(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
}

const isNested = (relativePath: string): boolean => relativePath.includes('/');
const depth = (relativePath: string): number => relativePath.split('/').length;

/**
 * Re-home flat legacy changes without touching nested work:
 * unlinked changes move under `<legacyDir>/`, linked changes move under the local platform tree.
 * Dry run by default; apply is journaled, resumable, and refuses to overwrite existing paths.
 */
export async function migrateWorkspace(root: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  const legacyDir = validatePathSegment((options.legacyDir ?? 'legacy').trim());
  const useRename = options.rename === true;
  const dryRun = options.apply !== true;
  const entries = await scanChangeDirectories(root, { scope: 'active' });
  const nodes: MigrateNode[] = [];
  for (const entry of entries) {
    const node: MigrateNode = { entry, id: entry.relativePath.split('/').pop()!, change: null, sidecar: null };
    try {
      node.change = await readChange(root, entry.relativePath);
      node.sidecar = await readBacklogSidecar(entry.directory);
    } catch (error) {
      node.error = error instanceof Error ? error.message : String(error);
    }
    nodes.push(node);
  }

  const byItem = new Map<number, MigrateNode>();
  for (const node of nodes) {
    const itemId = node.sidecar?.platform.itemId;
    if (itemId === undefined) continue;
    if (byItem.has(itemId)) { node.blockedReason = 'duplicate_item'; continue; }
    byItem.set(itemId, node);
  }

  const leafFor = (node: MigrateNode): string => {
    const linked = node.sidecar?.platform.itemId;
    if (linked === undefined) return `${legacyDir}/${node.id}`;
    if (!useRename) return node.id;
    const key = node.sidecar?.platform.key;
    if (!key) return node.id;
    return composeNodeDirectory({ key, slug: node.sidecar!.node.slug });
  };

  const visiting = new Set<string>();
  const finalPath = (node: MigrateNode): string => {
    if (node.target !== undefined) return node.target;
    if (node.error) { node.blockedReason ??= 'broken_change'; node.target = node.entry.relativePath; return node.target; }
    if (isNested(node.entry.relativePath)) { node.target = node.entry.relativePath; return node.target; }
    const leaf = leafFor(node);
    const parentItemId = node.sidecar?.platform.itemId === undefined ? undefined : node.sidecar.platform.parentItemId;
    if (parentItemId === undefined || parentItemId === null) {
      node.target = leaf;
      return node.target;
    }
    const parent = byItem.get(parentItemId);
    if (!parent) { node.blockedReason ??= 'missing_ancestor'; node.target = node.entry.relativePath; return node.target; }
    if (visiting.has(node.entry.relativePath)) { node.blockedReason ??= 'cycle'; node.target = node.entry.relativePath; return node.target; }
    visiting.add(node.entry.relativePath);
    const parentPath = finalPath(parent);
    visiting.delete(node.entry.relativePath);
    if (parent.blockedReason) {
      node.blockedReason ??= parent.blockedReason;
      node.target = node.entry.relativePath;
      return node.target;
    }
    node.target = `${parentPath}/${leaf}`;
    return node.target;
  };

  // Resolve targets, then block any move whose final path collides with another final path.
  for (const node of nodes) finalPath(node);
  for (let pass = 0; pass < 20; pass++) {
    const owners = new Map<string, MigrateNode[]>();
    for (const node of nodes) {
      const final = node.target ?? node.entry.relativePath;
      const key = final.toLowerCase();
      const list = owners.get(key);
      if (list) list.push(node); else owners.set(key, [node]);
    }
    let changed = false;
    for (const [key, list] of owners) {
      if (list.length < 2) continue;
      for (const node of list) {
        if (isNested(node.entry.relativePath) || node.blockedReason) continue;
        if (node.target?.toLowerCase() !== key) continue;
        node.blockedReason = 'path_conflict';
        node.target = node.entry.relativePath;
        changed = true;
      }
    }
    for (const node of nodes) {
      if (node.blockedReason || isNested(node.entry.relativePath) || node.sidecar?.platform.itemId === undefined) continue;
      const parentItemId = node.sidecar.platform.parentItemId;
      const parent = parentItemId === null || parentItemId === undefined ? undefined : byItem.get(parentItemId);
      if (parent?.blockedReason) { node.blockedReason = 'missing_ancestor'; node.target = node.entry.relativePath; changed = true; }
    }
    if (!changed) break;
  }

  const moves: MigrateMove[] = nodes
    .filter(node => !isNested(node.entry.relativePath))
    .map(node => {
      const target = node.target ?? node.entry.relativePath;
      if (node.blockedReason) return { from: node.entry.relativePath, to: target, action: 'skip' as const, reason: node.blockedReason };
      if (target === node.entry.relativePath) return { from: node.entry.relativePath, to: target, action: 'skip' as const, reason: 'unchanged' };
      return { from: node.entry.relativePath, to: target, action: 'move' as const };
    });
  const blocked = moves.filter(move => move.action === 'skip' && move.reason !== 'unchanged').length;
  const journalFile = path.join(root, '.notchlet', '.local', 'migrate.json');
  if (dryRun) {
    return { dryRun, legacyDir, rename: useRename, scanned: entries.length, moves, moved: 0, skipped: moves.length - moves.filter(move => move.action === 'move').length, blocked, journal: null };
  }

  const pending = moves.filter(move => move.action === 'move').sort((a, b) => depth(a.to) - depth(b.to) || a.to.localeCompare(b.to));
  if (pending.length) await writeJournal(journalFile, legacyDir, useRename, moves);
  const done = new Set<string>();
  let moved = 0;
  for (let guard = 0; guard < pending.length + 1 && done.size < pending.length; guard++) {
    let progressed = false;
    for (const move of pending) {
      if (done.has(move.from)) continue;
      const source = path.join(root, '.notchlet', 'changes', ...move.from.split('/'));
      const destination = path.join(root, '.notchlet', 'changes', ...move.to.split('/'));
      if (!(await pathExists(source))) {
        if (await pathExists(destination)) { done.add(move.from); move.action = 'move'; progressed = true; continue; }
        move.action = 'skip'; move.reason = 'source_missing'; done.add(move.from); progressed = true; continue;
      }
      if (await pathExists(destination)) {
        const pendingSource = pending.some(other => other !== move && !done.has(other.from) && other.from === move.to);
        if (pendingSource) continue;
        move.action = 'skip'; move.reason = 'path_exists'; done.add(move.from); progressed = true; continue;
      }
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await rename(source, destination);
        done.add(move.from); moved += 1; progressed = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY' || code === 'EEXIST') {
          move.action = 'skip'; move.reason = 'path_exists'; done.add(move.from); progressed = true;
        } else throw error;
      }
    }
    if (!progressed) break;
  }
  for (const move of pending) if (!done.has(move.from)) { move.action = 'skip'; move.reason = 'path_conflict'; }
  await writeJournal(journalFile, legacyDir, useRename, moves);
  const skipped = moves.filter(move => move.action === 'skip').length;
  return { dryRun, legacyDir, rename: useRename, scanned: entries.length, moves, moved, skipped, blocked: moves.filter(move => move.reason && move.reason !== 'unchanged').length, journal: journalFile };
}

async function writeJournal(file: string, legacyDir: string, useRename: boolean, moves: MigrateMove[]): Promise<void> {
  await atomicWriteJson(file, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    legacyDir,
    rename: useRename,
    moves: moves.map(move => ({ from: move.from, to: move.to, status: move.action === 'move' ? 'done' : move.reason === 'unchanged' ? 'skipped' : 'blocked', ...(move.reason ? { reason: move.reason } : {}) })),
  });
}

export async function readMigrateJournal(root: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path.join(root, '.notchlet', '.local', 'migrate.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
