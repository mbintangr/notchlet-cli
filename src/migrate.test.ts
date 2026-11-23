import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  emptyBacklogSidecar, initWorkspace, readBacklogSidecar, readChange, scaffold, scaffoldNode, withLinkedItem, writeBacklogSidecar,
} from '@notchlet/core';
import { migrateWorkspace } from './migrate.js';

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'notchlet-migrate-'));
  const root = path.join(temp, 'workspace');
  await mkdir(root);
  await initWorkspace(root);
  return { root, dispose: () => rm(temp, { recursive: true, force: true }) };
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

async function linkFlat(root: string, id: string, item: { itemId: number; key: string; itemType: 'EPIC' | 'STORY' | 'TASK' | 'SUBTASK'; title: string; parentItemId: number | null }) {
  const directory = path.join(root, '.notchlet', 'changes', id);
  const sidecar = withLinkedItem(emptyBacklogSidecar({ itemType: item.itemType, title: item.title, slug: id, origin: 'local' }), {
    productId: '31', itemId: item.itemId, key: item.key, parentItemId: item.parentItemId, remoteStatus: 'TODO',
  }, 'sync');
  await writeBacklogSidecar(directory, sidecar);
}

test('migrate previews by default and moves unlinked flat changes under legacy/', async () => {
  const f = await fixture();
  try {
    await scaffold(f.root, 'Loose work', 'quick');
    const preview = await migrateWorkspace(f.root);
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.moves.map(move => [move.from, move.to, move.action]), [['loose-work', 'legacy/loose-work', 'move']]);
    assert.equal(await exists(path.join(f.root, '.notchlet', 'changes', 'legacy')), false, 'dry run writes nothing');
    assert.equal(await exists(path.join(f.root, '.notchlet', '.local', 'migrate.json')), false);

    const applied = await migrateWorkspace(f.root, { apply: true });
    assert.equal(applied.moved, 1);
    assert.equal(await exists(path.join(f.root, '.notchlet', 'changes', 'legacy', 'loose-work')), true);
    assert.equal(await exists(path.join(f.root, '.notchlet', 'changes', 'loose-work')), false);
    assert.equal((await readChange(f.root, 'legacy/loose-work')).name, 'Loose work');
    const journal = JSON.parse(await readFile(path.join(f.root, '.notchlet', '.local', 'migrate.json'), 'utf8'));
    assert.equal(journal.moves[0].status, 'done');
  } finally { await f.dispose(); }
});

test('migrate re-homes linked flat changes under the local tree and keys folders on --rename', async () => {
  const f = await fixture();
  try {
    const epic = await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await linkFlat(f.root, epic.relativePath, { itemId: 1, key: 'NT-1', itemType: 'EPIC', title: 'Auth', parentItemId: null });
    await scaffold(f.root, 'Login', 'quick');
    await linkFlat(f.root, 'login', { itemId: 2, key: 'NT-2', itemType: 'STORY', title: 'Login', parentItemId: 1 });

    const preview = await migrateWorkspace(f.root, { rename: true });
    assert.deepEqual(preview.moves.map(move => [move.from, move.to]), [['auth', 'nt-1-auth'], ['login', 'nt-1-auth/nt-2-login']]);

    const applied = await migrateWorkspace(f.root, { apply: true, rename: true });
    assert.equal(applied.moved, 2);
    assert.equal((await readChange(f.root, 'nt-1-auth')).name, 'Auth');
    assert.equal((await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-auth', 'nt-2-login')))?.platform.itemId, 2);
    assert.equal(await exists(path.join(f.root, '.notchlet', 'changes', 'login')), false);
  } finally { await f.dispose(); }
});

test('migrate leaves changes with unresolved ancestors alone', async () => {
  const f = await fixture();
  try {
    await scaffold(f.root, 'Orphan', 'quick');
    await linkFlat(f.root, 'orphan', { itemId: 7, key: 'NT-7', itemType: 'STORY', title: 'Orphan', parentItemId: 999 });
    const preview = await migrateWorkspace(f.root, { rename: true });
    assert.deepEqual(preview.moves.map(move => [move.from, move.action, move.reason]), [['orphan', 'skip', 'missing_ancestor']]);
    assert.equal(preview.blocked, 1);

    const applied = await migrateWorkspace(f.root, { apply: true, rename: true });
    assert.equal(applied.moved, 0);
    assert.equal(await exists(path.join(f.root, '.notchlet', 'changes', 'orphan')), true);
  } finally { await f.dispose(); }
});
