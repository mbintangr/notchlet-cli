import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChangeTree, initWorkspace, readBacklogSidecar, readChange, scaffoldNode } from '@notchlet/core';
import { authCommand, type CredentialStore } from './auth.js';
import { importBacklogTree, syncTree, deliverTree, updateLocalBacklogPlanning } from './backlog-sync.js';

const server = 'https://tree.example';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const capabilities = {
  server: { id: 'tree-server', version: '1.0.0' }, protocol: { minimum: '1.0', maximum: '1.0' },
  versions: { core: '1.0.0', schema: '1.0.0' },
  limits: { snapshotUploadBytes: 1_048_576, instructionContextBytes: 32768, pageSizeDefault: 20, pageSizeMaximum: 100 },
  operations: ['createChange', 'uploadSnapshot', 'checkpoint', 'linkChange', 'delivery', 'getOperation'],
};

interface RemoteItem { id: number; productId: number; parentId: number | null; itemType: string; title: string; key: string | null; status: string; description: string; updatedAt: string; descriptionRevision?: number; priorityLevel?: string; storyPoints?: number; startDate?: string; dueDate?: string }
interface RemoteChange { id: string; productId: number; backlogItemId: number; title: string; description: string; revision: number; snapshotRevision: number; snapshots: any[]; content: Map<string, any> }

async function treeFixture(items: RemoteItem[] = []) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'notchlet-tree-sync-'));
  const root = path.join(temp, 'workspace');
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = path.join(temp, 'config'); delete process.env.NOTCHLET_TOKEN;
  await mkdir(root); await initWorkspace(root);
  await writeFile(path.join(root, '.notchlet', 'workspace.json'), JSON.stringify({
    binding: { server, serverIdentity: 'tree-server', protocol: capabilities.protocol, coreVersion: '1.0.0', schemaVersion: '1.0.0', productId: 31, repositoryId: 7 },
    preferences: { syncMode: 'manual' },
  }));
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'tree test store', async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const allItems = new Map<number, RemoteItem>(items.map(item => [item.id, item]));
  const changes = new Map<string, RemoteChange>();
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const control = { failCreate: false };
  let itemSequence = Math.max(0, ...items.map(item => item.id));
  let changeSequence = 0;
  const itemJson = (item: RemoteItem) => ({ ...item, descriptionRevision: item.descriptionRevision ?? 1 });
  const changeJson = (change: RemoteChange) => ({ id: change.id, productId: change.productId, backlogItemId: change.backlogItemId, title: change.title, description: change.description, status: 'open', revision: change.revision, snapshotRevision: change.snapshotRevision || null });

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path: url.pathname + url.search, body });
    if (url.pathname === '/auth/login') return Response.json({ accessToken: token, refreshToken: 'refresh-token', user: { email: 'tree@example.test' } });
    const header = new Headers(init?.headers).get('Authorization');
    if (header !== `Bearer ${token}`) return Response.json({ message: 'unauthorized' }, { status: 401 });
    if (url.pathname.endsWith('/capabilities')) return Response.json(capabilities);
    if (url.pathname === '/backlog' && method === 'GET') return Response.json([...allItems.values()].map(itemJson));
    if (url.pathname === '/backlog' && method === 'POST') {
      if (control.failCreate) throw new TypeError('fetch failed');
      const item: RemoteItem = { id: ++itemSequence, productId: body.productId, parentId: body.parentId ?? null, itemType: body.itemType, title: body.title, key: `NT-${itemSequence}`, status: 'TODO', description: body.description ?? '', updatedAt: '2026-01-01T00:00:00.000Z', descriptionRevision: 1 };
      for (const field of ['priorityLevel', 'storyPoints', 'startDate', 'dueDate'] as const) if (body[field] !== undefined) (item as unknown as Record<string, unknown>)[field] = body[field];
      allItems.set(item.id, item);
      return Response.json(itemJson(item), { status: 201 });
    }
    const itemMatch = url.pathname.match(/^\/backlog\/(\d+)$/);
    if (itemMatch) {
      const item = allItems.get(Number(itemMatch[1]));
      if (!item) return Response.json({ message: 'not found' }, { status: 404 });
      if (method === 'PATCH') {
        if (body.expectedDescriptionRevision !== undefined && body.expectedDescriptionRevision !== (item.descriptionRevision ?? 1)) return Response.json({ message: 'description revision conflict' }, { status: 409 });
        for (const field of ['title', 'description', 'priorityLevel', 'storyPoints', 'startDate', 'dueDate'] as const) if (body[field] !== undefined) (item as unknown as Record<string, unknown>)[field] = body[field];
        if (body.description !== undefined) item.descriptionRevision = (item.descriptionRevision ?? 1) + 1;
        item.updatedAt = '2026-01-02T00:00:00.000Z';
      }
      return Response.json(itemJson(item));
    }
    const contextMatch = url.pathname.match(/^\/backlog\/(\d+)\/development-context$/);
    if (contextMatch) {
      const id = Number(contextMatch[1]), section = url.searchParams.get('section');
      if (section === 'ancestors') {
        const chain: RemoteItem[] = [];
        let current = allItems.get(id)?.parentId ?? null;
        while (current !== null) { const ancestor = allItems.get(current); if (!ancestor) break; chain.push(ancestor); current = ancestor.parentId; }
        return Response.json({ itemId: id, section, items: chain.map(itemJson), hasMore: false, nextCursor: null });
      }
      if (section === 'children') {
        const children = [...allItems.values()].filter(item => item.parentId === id);
        return Response.json({ itemId: id, section, items: children.map(itemJson), hasMore: false, nextCursor: null });
      }
      return Response.json({ itemId: id, section: 'item', content: allItems.get(id)?.description ?? '', nextCursor: null });
    }
    if (url.pathname === '/development/v1/changes' && method === 'POST') {
      const id = `00000000-0000-4000-8000-${String(++changeSequence).padStart(12, '0')}`;
      const change: RemoteChange = { id, productId: body.productId, backlogItemId: body.backlogItemId, title: body.title, description: body.description, revision: 1, snapshotRevision: 0, snapshots: [], content: new Map() };
      changes.set(id, change);
      return Response.json(changeJson(change), { status: 201 });
    }
    const changeMatch = url.pathname.match(/^\/development\/v1\/changes\/([0-9a-f-]+)$/);
    if (changeMatch) {
      const change = changes.get(changeMatch[1]);
      if (!change) return Response.json({ message: 'not found' }, { status: 404 });
      if (method === 'PATCH') { if (body.backlogItemId !== undefined) change.backlogItemId = body.backlogItemId; return Response.json(changeJson(change)); }
      return Response.json(changeJson(change));
    }
    const snapshotsMatch = url.pathname.match(/^\/development\/v1\/changes\/([0-9a-f-]+)\/snapshots$/);
    if (snapshotsMatch) {
      const change = changes.get(snapshotsMatch[1]);
      if (!change) return Response.json({ message: 'not found' }, { status: 404 });
      if (method === 'GET') return Response.json({ items: change.snapshots, nextCursor: null, limit: 20 });
      const bytes = Buffer.from(body.content, 'base64'), sha256 = digest(bytes);
      change.revision += 1; change.snapshotRevision += 1;
      const snapshot = { id: `10000000-0000-4000-8000-${String(change.snapshotRevision).padStart(12, '0')}`, changeId: change.id, revision: change.snapshotRevision, changeRevision: change.revision, sha256, contentType: body.contentType, sizeBytes: bytes.length, createdAt: '2026-01-01T00:00:00Z' };
      change.snapshots.unshift(snapshot);
      change.content.set(snapshot.id, { ...snapshot, content: body.content });
      return Response.json(change.content.get(snapshot.id), { status: 201 });
    }
    const snapshotMatch = url.pathname.match(/^\/development\/v1\/changes\/([0-9a-f-]+)\/snapshots\/([0-9a-f-]+)$/);
    if (snapshotMatch) {
      const change = changes.get(snapshotMatch[1]);
      const snapshot = change?.content.get(snapshotMatch[2]);
      return snapshot ? Response.json(snapshot) : Response.json({ message: 'not found' }, { status: 404 });
    }
    const deliveryMatch = url.pathname.match(/^\/development\/v1\/changes\/([0-9a-f-]+)\/delivery$/);
    if (deliveryMatch && method === 'POST') {
      const change = changes.get(deliveryMatch[1]);
      if (!change) return Response.json({ message: 'not found' }, { status: 404 });
      const operationId = new Headers(init?.headers).get('Idempotency-Key');
      return Response.json({ operationId, changeId: change.id, status: 'delivered', snapshotRevision: body.snapshotRevision, changeRevision: change.revision, succeededTargets: ['backlog'], failedTargets: [], targets: { backlog: { status: 'delivered', backlogStatus: body.backlogStatus } }, completedAt: '2026-01-01T00:00:00Z' });
    }
    if (url.pathname.startsWith('/development/v1/operations/')) return Response.json({ message: 'not found' }, { status: 404 });
    return Response.json({ message: `unhandled ${method} ${url.pathname}` }, { status: 404 });
  }) as typeof fetch;

  await authCommand('login', { server, email: 'tree@example.test', password: 'hidden', fetch: fetcher, store });
  const replaceSnapshot = (changeId: string, mutate: (pkg: any) => void) => {
    const change = changes.get(changeId)!;
    const latest = change.snapshots[0];
    const pkg = JSON.parse(Buffer.from(change.content.get(latest.id).content, 'base64').toString());
    mutate(pkg);
    const bytes = Buffer.from(JSON.stringify(pkg));
    change.revision += 1; change.snapshotRevision += 1;
    const snapshot = { id: `20000000-0000-4000-8000-${String(change.snapshotRevision).padStart(12, '0')}`, changeId, revision: change.snapshotRevision, changeRevision: change.revision, sha256: digest(bytes), contentType: 'application/json', sizeBytes: bytes.length, createdAt: '2026-01-02T00:00:00Z' };
    change.snapshots.unshift(snapshot);
    change.content.set(snapshot.id, { ...snapshot, content: bytes.toString('base64') });
  };
  const dispose = async () => {
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(temp, { recursive: true, force: true });
  };
  return { root, store, fetcher, requests, control, allItems, changes, replaceSnapshot, dispose };
}

const importItems: RemoteItem[] = [
  { id: 1, productId: 31, parentId: null, itemType: 'EPIC', title: 'User authentication', key: 'NT-1', status: 'IN_PROGRESS', description: 'Deliver authentication.', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 2, productId: 31, parentId: 1, itemType: 'STORY', title: 'Login flow', key: 'NT-2', status: 'TODO', description: 'Users can log in.', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 3, productId: 31, parentId: 2, itemType: 'TASK', title: 'Login form', key: 'NT-3', status: 'TODO', description: 'Render the login form.', updatedAt: '2026-01-01T00:00:00.000Z' },
];

test('backlog import --tree scaffolds the platform hierarchy key-first and is idempotent', async () => {
  const f = await treeFixture(importItems);
  try {
    const result = await importBacklogTree(f.root, { productId: 31, itemId: 1, server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(result.nodes.map(node => node.relativePath), [
      'nt-1-user-authentication',
      'nt-1-user-authentication/nt-2-login-flow',
      'nt-1-user-authentication/nt-2-login-flow/nt-3-login-form',
    ]);
    const epic = await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-user-authentication'));
    const story = await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-user-authentication', 'nt-2-login-flow'));
    const task = await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-user-authentication', 'nt-2-login-flow', 'nt-3-login-form'));
    assert.equal(epic?.platform.itemId, 1);
    assert.equal(epic?.platform.key, 'NT-1');
    assert.equal(epic?.platform.parentItemId, null);
    assert.equal(epic?.node.origin, 'import');
    assert.equal(epic?.sync.state, 'linked');
    assert.equal(story?.platform.parentItemId, 1);
    assert.equal(task?.platform.itemId, 3);
    assert.equal((await readChange(f.root, 'nt-1-user-authentication')).tasks.length, 0, 'rollup nodes do not author their own tasks');
    const leaf = await readChange(f.root, 'nt-1-user-authentication/nt-2-login-flow/nt-3-login-form');
    assert.deepEqual(leaf.tasks.map(task => task.id), ['TASK-1']);
    assert.deepEqual(leaf.requirements.map(requirement => requirement.id), ['REQ-1']);
    assert.ok(leaf.checks.length >= 1);
    assert.equal((await buildChangeTree(f.root)).counts.total, 3);

    const again = await importBacklogTree(f.root, { productId: 31, itemId: 1, server, fetch: f.fetcher, store: f.store });
    assert.equal(again.nodes.length, 3);
    assert.ok(again.imported.every(node => node.action === 'reused'));
    assert.equal((await buildChangeTree(f.root)).counts.total, 3);
  } finally { await f.dispose(); }
});

test('importing a mid-level item scaffolds ancestor shells first', async () => {
  const f = await treeFixture(importItems);
  try {
    const result = await importBacklogTree(f.root, { productId: 31, itemId: 3, server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(result.nodes.map(node => `${node.itemType}:${node.relativePath}`), [
      'EPIC:nt-1-user-authentication',
      'STORY:nt-1-user-authentication/nt-2-login-flow',
      'TASK:nt-1-user-authentication/nt-2-login-flow/nt-3-login-form',
    ]);
  } finally { await f.dispose(); }
});

test('sync push --tree creates parents before children, adopts on retry, and pulls remote edits', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await scaffoldNode(f.root, { name: 'Login', itemType: 'STORY', parent: 'auth' });
    const first = await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(first.nodes.map(node => [node.relativePath, node.state]), [['auth', 'pushed'], ['auth/nt-2-login', 'pushed']]);
    const creates = f.requests.filter(request => request.path === '/backlog' && request.method === 'POST');
    assert.equal(creates.length, 2);
    assert.equal(creates[0].body.itemType, 'EPIC');
    assert.equal(creates[0].body.parentId, undefined);
    assert.equal(creates[1].body.itemType, 'STORY');
    assert.equal(creates[1].body.parentId, 1);
    const changeCreates = f.requests.filter(request => request.path === '/development/v1/changes' && request.method === 'POST');
    assert.deepEqual(changeCreates.map(request => request.body.backlogItemId), [1, 2]);
    const sidecar = await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'auth', 'nt-2-login'));
    assert.equal(sidecar?.platform.itemId, 2);
    assert.equal(sidecar?.platform.key, 'NT-2');
    assert.ok(await readFile(path.join(f.root, '.notchlet', '.local', 'sync', 'item-2.json'), 'utf8'));

    const second = await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(second.nodes.map(node => node.state), ['unchanged', 'unchanged']);
    assert.equal(f.requests.filter(request => request.path === '/backlog' && request.method === 'POST').length, 2);
    assert.equal(f.requests.filter(request => request.path === '/development/v1/changes' && request.method === 'POST').length, 2);

    const storyChange = [...f.changes.values()].find(change => change.backlogItemId === 2)!;
    f.replaceSnapshot(storyChange.id, pkg => {
      const tasks = JSON.parse(pkg.artifacts['tasks.json']);
      tasks.name = 'Login revised remotely';
      pkg.artifacts['tasks.json'] = `${JSON.stringify(tasks, null, 2)}\n`;
      pkg.change.name = 'Login revised remotely';
    });
    const pulled = await syncTree(f.root, 'auth', 'pull', { server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(pulled.nodes.map(node => node.state), ['unchanged', 'pulled']);
    assert.equal((await readChange(f.root, 'auth/nt-2-login')).name, 'Login revised remotely');
  } finally { await f.dispose(); }
});

test('an offline create journals pending-create and a retry adopts instead of duplicating', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    const syncDir = path.join(f.root, '.notchlet', '.local', 'sync');
    const pending = async () => (await readdir(syncDir).catch(() => [] as string[])).filter(name => name.endsWith('.backlog-create.operation.json'));
    f.control.failCreate = true;
    const failed = await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    assert.equal(failed.nodes[0].state, 'error');
    assert.match(failed.nodes[0].error ?? '', /Could not create the backlog item/);
    assert.equal((await pending()).length, 1);
    assert.equal(f.allItems.size, 0);

    f.control.failCreate = false;
    const retried = await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(retried.nodes.map(node => [node.relativePath, node.state]), [['nt-1-auth', 'pushed']]);
    assert.equal(f.allItems.size, 1);
    assert.equal((await pending()).length, 0);
    assert.equal((await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-auth')))?.platform.itemId, 1);
  } finally { await f.dispose(); }
});

test('sync push --tree without --yes previews every node and writes nothing', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await scaffoldNode(f.root, { name: 'Login', itemType: 'STORY', parent: 'auth' });
    const writesBefore = f.requests.filter(request => request.method !== 'GET').length;
    const preview = await syncTree(f.root, 'auth', 'push', { server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(preview.nodes.map(node => [node.relativePath, node.state]), [['auth', 'preview'], ['auth/login', 'preview']]);
    assert.equal(f.requests.filter(request => request.method !== 'GET').length, writesBefore);
    assert.equal(f.allItems.size, 0);
    assert.equal(f.changes.size, 0);
    assert.equal((await readdir(path.join(f.root, '.notchlet', '.local', 'sync')).catch(() => [] as string[])).length, 0);
    assert.equal((await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'auth')))?.platform.itemId, undefined);
  } finally { await f.dispose(); }
});

test('sync push --tree updates planning fields and applies description CAS', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    await updateLocalBacklogPlanning(f.root, 'nt-1-auth', { description: 'Auth epic description.', priorityLevel: 'MEDIUM' });
    const first = await syncTree(f.root, 'nt-1-auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    assert.equal(first.nodes[0].state, 'pushed');
    let patches = f.requests.filter(request => request.path === '/backlog/1' && request.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { description: 'Auth epic description.', expectedDescriptionRevision: 1, priorityLevel: 'MEDIUM' });
    assert.equal(f.allItems.get(1)?.descriptionRevision, 2);
    assert.equal(f.allItems.get(1)?.priorityLevel, 'MEDIUM');

    await updateLocalBacklogPlanning(f.root, 'nt-1-auth', { priorityLevel: 'HIGH', storyPoints: 3, startDate: '2026-12-01', dueDate: '2026-12-15T17:00:00Z' });
    const second = await syncTree(f.root, 'nt-1-auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    assert.equal(second.nodes[0].state, 'pushed');
    patches = f.requests.filter(request => request.path === '/backlog/1' && request.method === 'PATCH');
    assert.equal(patches.length, 2);
    assert.deepEqual(patches[1].body, { priorityLevel: 'HIGH', storyPoints: 3, startDate: '2026-12-01', dueDate: '2026-12-15T17:00:00Z' });
    assert.equal(f.allItems.get(1)?.priorityLevel, 'HIGH');
    assert.equal(f.allItems.get(1)?.storyPoints, 3);
    const sidecar = await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-auth'));
    assert.equal(sidecar?.sync.lastPushedPriorityLevel, 'HIGH');
    assert.equal(sidecar?.sync.lastPushedStoryPoints, 3);
    assert.equal(sidecar?.sync.lastPushedStartDate, '2026-12-01');
    assert.equal(sidecar?.sync.lastPushedDescriptionSha256, digest('Auth epic description.'));

    const unchanged = await syncTree(f.root, 'nt-1-auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    assert.equal(unchanged.nodes[0].state, 'unchanged');
    assert.equal(f.requests.filter(request => request.path === '/backlog/1' && request.method === 'PATCH').length, 2);
  } finally { await f.dispose(); }
});

test('sync push --tree reports divergent planning without overwriting the platform', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await updateLocalBacklogPlanning(f.root, 'auth', { priorityLevel: 'MEDIUM' });
    await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    const remote = f.allItems.get(1)!;
    remote.priorityLevel = 'URGENT';
    await updateLocalBacklogPlanning(f.root, 'nt-1-auth', { priorityLevel: 'HIGH' });
    const patchesBefore = f.requests.filter(request => request.method === 'PATCH').length;
    const pushed = await syncTree(f.root, 'nt-1-auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    assert.equal(f.allItems.get(1)?.priorityLevel, 'URGENT');
    assert.equal(f.requests.filter(request => request.method === 'PATCH').length, patchesBefore);
    assert.ok(pushed.warnings?.some(warning => /priorityLevel diverged: local HIGH, remote URGENT/.test(warning)));
    assert.equal((await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-auth')))?.planning?.priorityLevel, 'HIGH');
  } finally { await f.dispose(); }
});

test('sync pull --tree records remote planning observations with warnings', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await updateLocalBacklogPlanning(f.root, 'auth', { priorityLevel: 'MEDIUM', dueDate: '2026-12-01' });
    await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    const remote = f.allItems.get(1)!;
    remote.priorityLevel = 'HIGH';
    remote.dueDate = '2026-12-20';
    const pulled = await syncTree(f.root, 'nt-1-auth', 'pull', { server, fetch: f.fetcher, store: f.store });
    assert.ok(pulled.warnings?.some(warning => /priorityLevel differs on the platform/.test(warning)));
    assert.ok(pulled.warnings?.some(warning => /dueDate differs on the platform/.test(warning)));
    const sidecar = await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-auth'));
    assert.equal(sidecar?.platform.priorityLevel, 'HIGH');
    assert.equal(sidecar?.platform.dueDate, '2026-12-20');
    assert.equal(sidecar?.planning?.priorityLevel, 'MEDIUM');
    assert.equal(sidecar?.planning?.dueDate, '2026-12-01');
  } finally { await f.dispose(); }
});

test('sync pull --tree imports remote-only children only when requested and dry-run scaffolds nothing', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    f.allItems.set(2, { id: 2, productId: 31, parentId: 1, itemType: 'STORY', title: 'Login flow', key: 'NT-2', status: 'TODO', description: 'Users can log in.', updatedAt: '2026-01-02T00:00:00.000Z' });

    const report = await syncTree(f.root, 'nt-1-auth', 'pull', { server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(report.remoteOnly, [{ parentItemId: 1, itemIds: [2] }]);
    assert.equal(report.imported, undefined);
    assert.equal((await buildChangeTree(f.root)).counts.total, 1);

    const preview = await syncTree(f.root, 'nt-1-auth', 'pull', { server, fetch: f.fetcher, store: f.store, importNew: true, dryRun: true });
    assert.equal(preview.imported?.[0].dryRun, true);
    assert.ok((preview.imported?.[0].nodes ?? 0) >= 1);
    assert.equal((await buildChangeTree(f.root)).counts.total, 1);

    const applied = await syncTree(f.root, 'nt-1-auth', 'pull', { server, fetch: f.fetcher, store: f.store, importNew: true });
    assert.equal(applied.imported?.[0].dryRun, false);
    const tree = await buildChangeTree(f.root);
    assert.equal(tree.counts.total, 2);
    const child = await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-auth', 'nt-2-login-flow'));
    assert.equal(child?.platform.itemId, 2);
    assert.equal(child?.platform.parentItemId, 1);

    const again = await syncTree(f.root, 'nt-1-auth', 'pull', { server, fetch: f.fetcher, store: f.store, importNew: true });
    assert.deepEqual(again.remoteOnly, []);
    assert.equal(again.imported, undefined);
    assert.equal((await buildChangeTree(f.root)).counts.total, 2);
  } finally { await f.dispose(); }
});

test('sync push --tree keeps a single key prefix on imported leaves', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    f.allItems.set(2, { id: 2, productId: 31, parentId: 1, itemType: 'STORY', title: 'Login flow', key: 'NT-2', status: 'TODO', description: 'Users can log in.', updatedAt: '2026-01-02T00:00:00.000Z' });

    await syncTree(f.root, 'nt-1-auth', 'pull', { server, fetch: f.fetcher, store: f.store, importNew: true });
    assert.ok((await buildChangeTree(f.root)).byPath.has('nt-1-auth/nt-2-login-flow'));

    await syncTree(f.root, 'nt-1-auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    const tree = await buildChangeTree(f.root);
    assert.ok(tree.byPath.has('nt-1-auth/nt-2-login-flow'));
    assert.equal(tree.nodes.some(node => node.relativePath.includes('nt-2-nt-2-')), false);
    assert.equal((await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'nt-1-auth', 'nt-2-login-flow')))?.node.slug, 'nt-2-login-flow');
  } finally { await f.dispose(); }
});

test('sync deliver --with-children delivers bottom-up with an explicit DONE status', async () => {
  const f = await treeFixture();
  try {
    await scaffoldNode(f.root, { name: 'Auth', itemType: 'EPIC' });
    await scaffoldNode(f.root, { name: 'Login', itemType: 'STORY', parent: 'auth' });
    await syncTree(f.root, 'auth', 'push', { yes: true, server, fetch: f.fetcher, store: f.store });
    const result = await deliverTree(f.root, 'auth', { status: 'DONE', withChildren: true }, { server, fetch: f.fetcher, store: f.store });
    assert.deepEqual(result.nodes.map(node => node.relativePath), ['auth/nt-2-login', 'auth']);
    assert.equal(result.completed, 2);
    assert.equal(result.blocked, 0);
    const deliveries = f.requests.filter(request => request.path.endsWith('/delivery') && request.method === 'POST');
    assert.deepEqual(deliveries.map(request => request.body.backlogStatus), ['DONE', 'DONE']);
    assert.deepEqual(deliveries.map(request => request.body.target), ['backlog', 'backlog']);
    assert.equal((await readBacklogSidecar(path.join(f.root, '.notchlet', 'changes', 'auth')))?.platform.remoteStatus, 'DONE');
  } finally { await f.dispose(); }
});
