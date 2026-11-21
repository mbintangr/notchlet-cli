import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initWorkspace, scaffold } from '@notchlet/core';
import { authCommand, resolveCredential, type CredentialStore } from './auth.js';
import { autoSyncChange, bindWorkspace, callMcpTool, doctor, getWorkspaceSyncMode, importBacklogItem, setWorkspaceSyncMode, syncCheckpoint, syncPull, syncPush, syncResolve, syncStatus } from './integration.js';

function mockDevelopmentServer(state: { capabilities: any; productAccessible?: boolean; repository?: any }) {
  const tools = ['workspace_context', 'product_get_details', 'backlog_list', 'backlog_get', 'backlog_development_context'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', () => {
      const message = JSON.parse(body), id = message.id;
      if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      let result: any;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local-test', version: '1.0.0' } };
      else if (message.method === 'tools/list') result = { tools };
      else if (message.method === 'tools/call') {
        const { name, arguments: args = {} } = message.params;
        const value = name === 'workspace_context' ? state.productAccessible === false ? [] : [{ id: 3, teams: [{ products: [{ id: 31 }] }] }]
          : name === 'product_get_details' ? state.productAccessible === false ? { id: 32 } : { id: 31 }
          : name === 'backlog_list' ? [{ id: 55, productId: 31, title: 'Repository carrier' }]
          : name === 'backlog_get' ? { id: Number(args.itemId), productId: 31, title: 'Item', description: 'Description' }
          : args.section === 'repositories' ? { itemId: 55, section: 'repositories', items: [state.repository ?? { id: 7, repoLabel: 'Repo', provider: 'GITHUB', repoOwner: 'Acme', repoName: 'Repo', serverUrl: null }], hasMore: false, nextCursor: null }
          : { itemId: 55, context: {} };
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  server.listen(0, '127.0.0.1');
  return { server, ready: once(server, 'listening').then(() => {
    const address = server.address(); assert(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/development/v1/capabilities') return new Response(JSON.stringify(state.capabilities), { status: 200, headers: { 'content-type': 'application/json' } });
      return fetch(input, init);
    }) as typeof fetch;
    return { endpoint, fetcher };
  }), close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('SDK import preserves stored versus live Git provenance without promoting stored branch metadata', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-mcp-local-'));
  const config = path.join(dir, 'config'), root = path.join(dir, 'checkout');
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = config; process.env.NOTCHLET_TOKEN = 'local-test-token';
  await mkdir(root); await initWorkspace(root);
  const calls: Array<{ name: string; args: any }> = [];
  const definitions = ['workspace_context', 'product_get_details', 'backlog_get', 'backlog_development_context'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
  const dataFor = (name: string, args: any) => {
    calls.push({ name, args });
    if (name === 'backlog_development_context') return {
      itemId: 77,
      context: { sections: ['item'] },
      git: {
        stored: { branch: 'feature/stored-branch', provenance: 'backlog metadata; not live-verified' },
        live: { branch: 'main', provenance: 'current local checkout inspection' },
      },
      ...(!args.cursor ? { nextCursor: 'bounded-page-cursor' } : {}),
    };
    return name === 'workspace_context' ? { organizations: [{ teams: [{ products: [{ id: 31 }] }] }] }
      : name === 'product_get_details' ? { id: 31 }
      : name === 'backlog_get' ? { id: 77, productId: 31, title: 'Keep exact title', description: 'User-authored description survives import.' }
      : { itemId: 77 };
  };
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', () => {
      const message = JSON.parse(body), id = message.id;
      if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      let result: any;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local-test', version: '1.0.0' } };
      else if (message.method === 'tools/list') result = { tools: definitions };
      else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(dataFor(message.params.name, message.params.arguments ?? {})) }] };
      else { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  try {
    await authCommand('login', { server: 'https://profile.example', json: true });
    assert.equal((await callMcpTool<any>('backlog_development_context', { itemId: 77, section: 'item', limit: 20 }, { server: 'https://profile.example', endpoint })).content[0].type, 'text');
    const imported = await importBacklogItem(root, { productId: 31, itemId: 77, server: 'https://profile.example', endpoint });
    const proposal = await readFile(path.join(root, '.notchlet', 'changes', imported.id, 'proposal.md'), 'utf8');
    assert.match(proposal, /User-authored description survives import/);
    const context = JSON.parse(proposal.split('## Bounded development context\n\n')[1]);
    const importedGit = context.pages[0].git;
    assert.deepEqual(importedGit.stored, { branch: 'feature/stored-branch', provenance: 'backlog metadata; not live-verified' });
    assert.deepEqual(importedGit.live, { branch: 'main', provenance: 'current local checkout inspection' });
    assert.notEqual(importedGit.stored.branch, importedGit.live.branch);
    assert.doesNotMatch(JSON.stringify(importedGit.stored), /current local checkout/i);
    assert.deepEqual(calls.slice(-4).map(call => call.name), ['backlog_development_context', 'backlog_get', 'backlog_development_context', 'backlog_development_context']);
    assert.equal(calls.at(-1)?.args.itemId, 77);
    assert.equal(calls.at(-1)?.args.limit, 20);
    assert.equal(calls.at(-1)?.args.cursor, 'bounded-page-cursor');
    await assert.rejects(importBacklogItem(root, { productId: 31, itemId: 77, server: 'https://profile.example', endpoint }), /already linked/);
    assert.match(await readFile(path.join(root, '.notchlet', 'imports', '77.json'), 'utf8'), /"productId": 31/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('email/password authenticated backlog import uses product-authorized REST context without requiring an MCP API key', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-user-api-import-'));
  const config = path.join(dir, 'config'), root = path.join(dir, 'checkout');
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = config; delete process.env.NOTCHLET_TOKEN;
  await mkdir(root); await initWorkspace(root);
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'test OS store', async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const paths: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    paths.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname === '/auth/login') return Response.json({ accessToken: token, refreshToken: 'refresh-token', user: { email: 'reader@example.test' } });
    if (url.pathname === '/backlog/77') return Response.json({ id: 77, productId: 31, title: 'REST item', description: 'Read through the account session.' });
    if (url.pathname === '/backlog/77/development-context') return Response.json({ itemId: 77, section: 'item', context: { bounded: true }, nextCursor: null });
    return Response.json({ message: 'not found' }, { status: 404 });
  }) as typeof fetch;
  try {
    await authCommand('login', { server: 'https://user-api.example', email: 'reader@example.test', password: 'hidden', fetch: fetcher, store });
    const imported = await importBacklogItem(root, { productId: 31, itemId: 77, server: 'https://user-api.example', fetch: fetcher, store });
    const proposal = await readFile(path.join(root, '.notchlet', 'changes', imported.id, 'proposal.md'), 'utf8');
    assert.match(proposal, /Read through the account session/);
    assert.ok(paths.includes('GET /backlog/77'));
    assert.ok(paths.includes('GET /backlog/77/development-context?section=item&limit=20'));
    assert.equal(paths.some(path => path.includes('/mcp')), false);
  } finally {
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('documented account setup authenticates against an isolated HTTP backend without health probes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-http-fixture-'));
  const config = path.join(dir, 'config'), root = path.join(dir, 'checkout');
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = config; delete process.env.NOTCHLET_TOKEN;
  await mkdir(root); await initWorkspace(root);
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'fixture credential store', async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const requests: Array<{ method: string; path: string; authorization?: string }> = [];
  const server = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', () => {
      requests.push({ method: req.method ?? 'GET', path: req.url ?? '', authorization: req.headers.authorization });
      if (req.url === '/auth/login' && req.method === 'POST') {
        assert.deepEqual(JSON.parse(body), { email: 'setup@example.test', password: 'fixture-password' });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accessToken: token, refreshToken: 'fixture-refresh', user: { email: 'setup@example.test' } })); return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      if (req.url === '/development/v1/capabilities') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ server: { id: 'fixture', version: '1' }, protocol: { minimum: '1', maximum: '1' }, versions: { core: '1', schema: '1' }, operations: [] })); return; }
      res.writeHead(404).end();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return fetch(`http://127.0.0.1:${address.port}${request.pathname}${request.search}`, init);
  }) as typeof fetch;
  try {
    await authCommand('login', { server: 'https://fixture.example', email: 'setup@example.test', password: 'fixture-password', fetch: fetcher, store });
    const credential = await resolveCredential({ server: 'https://fixture.example', fetch: fetcher, store });
    assert.equal(credential.authMode, 'user');
    const capabilities = await fetcher('https://fixture.example/development/v1/capabilities', { headers: { Authorization: `Bearer ${credential.token}` } });
    assert.equal(capabilities.status, 200);
    assert.deepEqual(requests.map(request => `${request.method} ${request.path}`), ['POST /auth/login', 'GET /development/v1/capabilities']);
    assert.equal(requests[0].authorization, undefined);
    assert.equal(requests[1].authorization, `Bearer ${token}`);
    assert.ok(requests.every(request => !/health|ready|live/i.test(request.path)));
    assert.doesNotMatch(await readFile(path.join(config, 'profiles.json'), 'utf8'), /fixture-password|fixture-refresh|signature/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('doctor distinguishes offline from a missing capabilities route while local-only CLI status remains usable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-doctor-offline-'));
  const config = path.join(dir, 'config'), root = path.join(dir, 'workspace');
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = config; process.env.NOTCHLET_TOKEN = 'offline-test-secret';
  try {
    await authCommand('login', { server: 'https://offline.example', json: true });
    const offline = await doctor(null, { server: 'https://offline.example', fetch: (async () => { throw new Error('offline-test-secret must stay private'); }) as typeof fetch });
    const missingRoute = await doctor(null, { server: 'https://offline.example', fetch: (async () => new Response('not found', { status: 404 })) as typeof fetch });
    assert.equal(offline.diagnostic, 'offline');
    assert.equal(missingRoute.diagnostic, 'endpoint_not_found');
    assert.doesNotMatch(JSON.stringify([offline, missingRoute]), /offline-test-secret|must stay private/);
    await mkdir(root); await initWorkspace(root);
    const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
    const status = spawnSync(process.execPath, [cli, 'status', '--json'], { cwd: root, encoding: 'utf8', env: process.env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).ok, true);
    assert.equal(JSON.parse(status.stdout).data.workspace, root);
  } finally {
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace binding records stable server identity and capability versions; identity, product and repository changes are guarded', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-bind-local-'));
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = path.join(dir, 'config'); process.env.NOTCHLET_TOKEN = 'local-token';
  const root = path.join(dir, 'checkout'); await mkdir(root); await initWorkspace(root);
  const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const state: { capabilities: any; productAccessible?: boolean; repository?: any } = { capabilities: { server: { id: 'server-stable-1', version: '1.0.0' }, protocol: { minimum: '1.0', maximum: '1.0' }, versions: { core: '1.0.0', schema: '1.0.0' }, operations: ['read'] } };
  const mock = mockDevelopmentServer(state), { endpoint, fetcher } = await mock.ready;
  try {
    git('init'); git('remote', 'add', 'origin', 'git@github.com:Acme/Repo.git');
    await authCommand('login', { server: 'https://one.example', json: true });
    await authCommand('login', { server: 'https://two.example', json: true });
    const first = await bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher });
    assert.equal(first.binding.serverIdentity, 'server-stable-1');
    assert.equal(first.binding.repositoryRemote, 'github.com/acme/repo');
    assert.deepEqual(first.binding.protocol, { minimum: '1.0', maximum: '1.0' });
    assert.equal(first.binding.coreVersion, '1.0.0');
    assert.equal(first.binding.schemaVersion, '1.0.0');
    assert.equal((await bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher })).alreadyBound, true);
    await assert.rejects(bindWorkspace(root, { server: 'https://two.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher }), /rebind/);
    await bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher, rebind: true });
    state.capabilities = { ...state.capabilities, server: { id: 'server-stable-2', version: '2.0.0' }, versions: { core: '2.0.0', schema: '1.0.0' } };
    await assert.rejects(bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher }), /rebind/);
    await bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher, rebind: true });
    assert.equal(JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8')).binding.serverIdentity, 'server-stable-2');
    state.productAccessible = false;
    await assert.rejects(bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher, rebind: true }), /not accessible/);
    state.productAccessible = true;
    state.repository = { id: 8, repoLabel: 'Wrong Repo', provider: 'GITHUB', repoOwner: 'Acme', repoName: 'Repo', serverUrl: null };
    await assert.rejects(bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher, rebind: true }), /repository ID/);
    state.repository = { id: 7, repoLabel: 'Wrong remote', provider: 'GITHUB', repoOwner: 'Acme', repoName: 'Wrong', serverUrl: null };
    await assert.rejects(bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher, rebind: true }), /does not match/);
    state.repository = { id: 7, repoLabel: 'Repo', provider: 'GITHUB', repoOwner: 'Acme', repoName: 'Repo', serverUrl: null };
    git('remote', 'set-url', 'origin', 'https://github.com/acme/repo.git');
    await bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher });
    git('remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    await assert.rejects(bindWorkspace(root, { server: 'https://one.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher, rebind: true }), /does not match/);
    const metadata = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    assert.equal(metadata.binding.server, 'https://one.example');
    assert.equal(metadata.binding.repositoryRemote, 'github.com/acme/repo');
  } finally {
    await mock.close();
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('doctor produces bounded redacted diagnostics for revoked or insufficient credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-doctor-'));
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; process.env.NOTCHLET_TOKEN = 'never-report-this-token';
  try {
    await authCommand('login', { server: 'https://doctor.example', json: true });
    const revoked = await doctor(null, { server: 'https://doctor.example', fetch: (async () => new Response('', { status: 401 })) as typeof fetch });
    assert.equal(revoked.diagnostic, 'credential_revoked');
    const denied = await doctor(null, { server: 'https://doctor.example', fetch: (async () => new Response('', { status: 403 })) as typeof fetch });
    assert.equal(denied.diagnostic, 'scope_insufficient');
    const missingRoute = await doctor(null, { server: 'https://doctor.example', fetch: (async () => new Response('', { status: 404 })) as typeof fetch });
    assert.equal(missingRoute.diagnostic, 'endpoint_not_found');
    assert.doesNotMatch(JSON.stringify([revoked, denied]), /never-report-this-token/);
  } finally {
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('doctor reports changed server identity, capability versions, and current checkout remote', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-doctor-binding-'));
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = path.join(dir, 'config'); process.env.NOTCHLET_TOKEN = 'doctor-local-token';
  const root = path.join(dir, 'checkout'); await mkdir(root); await initWorkspace(root);
  const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const state = { capabilities: { server: { id: 'doctor-stable', version: '1.0.0' }, protocol: { minimum: '1.0', maximum: '1.0' }, versions: { core: '1.0.0', schema: '1.0.0' }, operations: ['read'] } };
  const mock = mockDevelopmentServer(state), { endpoint, fetcher } = await mock.ready;
  try {
    git('init'); git('remote', 'add', 'origin', 'https://github.com/acme/repo.git');
    await authCommand('login', { server: 'https://doctor.example', json: true });
    await bindWorkspace(root, { server: 'https://doctor.example', productId: 31, repositoryId: 7, endpoint, fetch: fetcher });
    assert.equal((await doctor(root, { server: 'https://doctor.example', endpoint, fetch: fetcher })).diagnostic, 'ok');
    state.capabilities = { ...state.capabilities, server: { id: 'different-server', version: '1.0.0' } };
    assert.equal((await doctor(root, { server: 'https://doctor.example', endpoint, fetch: fetcher })).diagnostic, 'server_identity_mismatch');
    state.capabilities = { ...state.capabilities, server: { id: 'doctor-stable', version: '2.0.0' }, versions: { core: '2.0.0', schema: '1.0.0' } };
    assert.equal((await doctor(root, { server: 'https://doctor.example', endpoint, fetch: fetcher })).diagnostic, 'backend_version_mismatch');
    state.capabilities = { ...state.capabilities, server: { id: 'doctor-stable', version: '1.0.0' }, versions: { core: '1.0.0', schema: '1.0.0' } };
    git('remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    assert.equal((await doctor(root, { server: 'https://doctor.example', endpoint, fetch: fetcher })).diagnostic, 'repository_mismatch');
  } finally {
    await mock.close();
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

const syncCapabilities = {
  server: { id: 'sync-server', version: '1.0.0' }, protocol: { minimum: '1.0', maximum: '1.0' },
  versions: { core: '1.0.0', schema: '1.0.0' },
  limits: { snapshotUploadBytes: 1_048_576, instructionContextBytes: 32768, pageSizeDefault: 20, pageSizeMaximum: 100 },
  operations: ['createChange', 'uploadSnapshot', 'checkpoint', 'getOperation'],
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function syncFixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'notchlet-sync-'));
  const root = path.join(temp, 'workspace'), server = 'https://sync.example';
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = path.join(temp, 'config'); process.env.NOTCHLET_TOKEN = 'mock-only-token';
  await mkdir(root); await initWorkspace(root);
  await writeFile(path.join(root, '.notchlet', 'workspace.json'), JSON.stringify({ binding: { server, serverIdentity: 'sync-server', protocol: syncCapabilities.protocol, coreVersion: '1.0.0', schemaVersion: '1.0.0', productId: 31, repositoryId: 7 } }));
  await authCommand('login', { server, json: true });
  const remoteId = '11111111-1111-4111-8111-111111111111';
  const remote: { metadata: any; snapshots: any[]; content: Map<string, any>; requests: any[]; uploadStatus: number | null; caps: any; operations: Map<string, any>; loseNextWriteResponse: boolean; checkpointComments: any[] } = {
    metadata: { id: remoteId, productId: 31, title: '', status: 'open', revision: 1, snapshotRevision: null },
    snapshots: [], content: new Map(), requests: [], uploadStatus: null, caps: syncCapabilities, operations: new Map(), loseNextWriteResponse: false, checkpointComments: [],
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    remote.requests.push({ path: url.pathname, method, headers: init?.headers, body });
    if (url.pathname.endsWith('/capabilities')) return Response.json(remote.caps);
    if (url.pathname.startsWith('/development/v1/operations/') && method === 'GET') {
      const operation = remote.operations.get(url.pathname.split('/').pop()!);
      return operation ? Response.json(operation) : Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    }
    if (url.pathname === '/development/v1/changes' && method === 'POST') {
      remote.metadata = { ...remote.metadata, title: body.title, revision: 1 };
      const key = new Headers(init?.headers).get('Idempotency-Key')!;
      const payloadHash = new Headers(init?.headers).get('X-Payload-SHA256')!;
      remote.operations.set(key, { operationId: key, payloadHash, state: 'succeeded', response: remote.metadata });
      if (remote.loseNextWriteResponse) { remote.loseNextWriteResponse = false; throw new TypeError('simulated lost response after commit'); }
      return Response.json(remote.metadata, { status: 201 });
    }
    if (url.pathname === `/development/v1/changes/${remoteId}` && method === 'GET') return Response.json(remote.metadata);
    if (url.pathname === `/development/v1/changes/${remoteId}/snapshots` && method === 'GET') return Response.json({ items: remote.snapshots, nextCursor: null, limit: 20 });
    if (url.pathname === `/development/v1/changes/${remoteId}/snapshots` && method === 'POST') {
      if (remote.uploadStatus !== null) { const status = remote.uploadStatus; remote.uploadStatus = null; return Response.json({ code: 'REVISION_CONFLICT' }, { status }); }
      const bytes = Buffer.from(body.content, 'base64'), sha256 = digest(bytes);
      remote.metadata = { ...remote.metadata, revision: remote.metadata.revision + 1, snapshotRevision: (remote.metadata.snapshotRevision ?? 0) + 1 };
      const snapshot = { id: `22222222-2222-4222-8222-${String(remote.metadata.snapshotRevision).padStart(12, '0')}`, changeId: remoteId, revision: remote.metadata.snapshotRevision, changeRevision: remote.metadata.revision, sha256, contentType: body.contentType, sizeBytes: bytes.length, createdAt: '2026-01-01T00:00:00Z' };
      remote.snapshots.unshift(snapshot); remote.content.set(snapshot.id, { ...snapshot, content: body.content, sourceRevision: body.sourceRevision });
      const key = new Headers(init?.headers).get('Idempotency-Key')!;
      const payloadHash = new Headers(init?.headers).get('X-Payload-SHA256')!;
      remote.operations.set(key, { operationId: key, payloadHash, state: 'succeeded', response: remote.content.get(snapshot.id) });
      if (remote.loseNextWriteResponse) { remote.loseNextWriteResponse = false; throw new TypeError('simulated lost response after commit'); }
      return Response.json(remote.content.get(snapshot.id), { status: 201 });
    }
    if (url.pathname === `/development/v1/changes/${remoteId}/checkpoints` && method === 'POST') {
      const key = new Headers(init?.headers).get('Idempotency-Key')!;
      const payloadHash = new Headers(init?.headers).get('X-Payload-SHA256')!;
      const checkpoint = { id: key, changeId: remoteId, ...body, changeRevision: ++remote.metadata.revision, createdAt: '2026-01-01T00:00:00Z' };
      remote.checkpointComments.push(checkpoint);
      remote.operations.set(key, { operationId: key, payloadHash, state: 'succeeded', response: checkpoint });
      if (remote.loseNextWriteResponse) { remote.loseNextWriteResponse = false; throw new TypeError('simulated lost response after commit'); }
      return Response.json(checkpoint, { status: 201 });
    }
    const contentMatch = url.pathname.match(new RegExp(`/development/v1/changes/${remoteId}/snapshots/([^/]+)$`));
    if (contentMatch && method === 'GET') return Response.json(remote.content.get(contentMatch[1]));
    return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
  }) as typeof fetch;
  const dispose = async () => {
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(temp, { recursive: true, force: true });
  };
  return { root, server, remote, fetcher, dispose, remoteId };
}

test('sync preview and first push create one remote change and use distinct idempotency keys; interrupted upload resumes without duplicate create', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Sync example', 'quick');
    const preview = await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher });
    assert.equal(preview.state, 'preview');
    assert.equal(f.remote.requests.filter(r => r.method === 'POST').length, 0);
    f.remote.uploadStatus = 412;
    const conflict = await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true });
    assert.equal(conflict.state, 'conflict');
    const stateFile = JSON.parse(await readFile(path.join(f.root, '.notchlet', '.local', 'sync', `${change.id}.json`), 'utf8'));
    assert.equal(stateFile.remoteId, f.remoteId);
    const retry = await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true });
    assert.equal(retry.state, 'pushed');
    assert.equal(f.remote.requests.filter(r => r.path === '/development/v1/changes' && r.method === 'POST').length, 1);
    const writes = f.remote.requests.filter(r => r.method === 'POST');
    assert.notEqual(new Headers(writes[0].headers).get('Idempotency-Key'), new Headers(writes[1].headers).get('Idempotency-Key'));
    assert.equal(new Headers(writes[0].headers).get('If-Match'), '"0"');
    assert.equal(new Headers(writes[1].headers).get('If-Match'), '"1"');
    const pushed = JSON.parse(Buffer.from(writes[1].body.content, 'base64').toString());
    assert.deepEqual(Object.keys(pushed).sort(), ['artifacts', 'change', 'evidence']);
    assert.equal((await syncStatus(f.root, change.id, { server: f.server, fetch: f.fetcher })).state, 'unchanged');
  } finally { await f.dispose(); }
});

test('auto sync keeps offline local work and reconciles it on the next online CLI operation', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Automatic sync example', 'quick');
    await setWorkspaceSyncMode(f.root, 'auto');
    assert.equal(await getWorkspaceSyncMode(f.root), 'auto');
    const offline = await autoSyncChange(f.root, change.id, { server: f.server, fetch: (async () => { throw new TypeError('offline'); }) as typeof fetch });
    assert.equal(offline.state, 'pending');
    assert.equal(f.remote.metadata.snapshotRevision, null);
    assert.equal(JSON.parse(await readFile(path.join(f.root, '.notchlet', 'changes', change.id, 'proposal.json'), 'utf8')).change.name, 'Automatic sync example');

    const reconnected = await autoSyncChange(f.root, change.id, { server: f.server, fetch: f.fetcher });
    assert.equal(reconnected.state, 'pushed');
    assert.equal(f.remote.metadata.snapshotRevision, 1);
    await writeFile(path.join(f.root, '.notchlet', 'changes', change.id, 'proposal.json'), '# Updated after reconnect\n');
    const nextLocalEdit = await autoSyncChange(f.root, change.id, { server: f.server, fetch: f.fetcher });
    assert.equal(nextLocalEdit.state, 'pushed');
    assert.equal(f.remote.metadata.snapshotRevision, 2);

    await setWorkspaceSyncMode(f.root, 'manual');
    assert.equal(await getWorkspaceSyncMode(f.root), 'manual');
    await writeFile(path.join(f.root, '.notchlet', 'changes', change.id, 'proposal.json'), '# Manual edit\n');
    assert.equal((await autoSyncChange(f.root, change.id, { server: f.server, fetch: f.fetcher })).state, 'manual');
    assert.equal(f.remote.metadata.snapshotRevision, 2);
  } finally { await f.dispose(); }
});

test('sync push reconciles a lost create response and a lost snapshot response without duplicate writes', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Lost response recovery', 'quick');
    f.remote.loseNextWriteResponse = true;
    await assert.rejects(syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true }), /simulated lost response/);
    const createJournal = JSON.parse(await readFile(path.join(f.root, '.notchlet', '.local', 'sync', `${change.id}.create.operation.json`), 'utf8'));
    assert.equal(f.remote.requests.filter(r => r.path === '/development/v1/changes' && r.method === 'POST').length, 1);
    assert.equal((await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true })).state, 'pushed');
    assert.equal(f.remote.requests.filter(r => r.path === '/development/v1/changes' && r.method === 'POST').length, 1);
    assert.ok(f.remote.requests.some(r => r.path === `/development/v1/operations/${createJournal.operationId}`));

    const second = await scaffold(f.root, 'Lost upload response recovery', 'quick');
    assert.equal((await syncPush(f.root, second.id, { server: f.server, fetch: f.fetcher, yes: true })).state, 'pushed');
    await writeFile(path.join(f.root, '.notchlet', 'changes', second.id, 'proposal.json'), '# Updated snapshot\n');
    f.remote.loseNextWriteResponse = true;
    await assert.rejects(syncPush(f.root, second.id, { server: f.server, fetch: f.fetcher, yes: true }), /simulated lost response/);
    const uploadJournal = JSON.parse(await readFile(path.join(f.root, '.notchlet', '.local', 'sync', `${second.id}.snapshot.operation.json`), 'utf8'));
    const snapshotCountAfterCommit = f.remote.snapshots.length;
    assert.equal((await syncPush(f.root, second.id, { server: f.server, fetch: f.fetcher, yes: true })).state, 'unchanged');
    assert.equal(f.remote.snapshots.length, snapshotCountAfterCommit);
    assert.ok(f.remote.requests.some(r => r.path === `/development/v1/operations/${uploadJournal.operationId}`));
    assert.equal(JSON.parse(await readFile(path.join(f.root, '.notchlet', '.local', 'sync', `${second.id}.json`), 'utf8')).remoteId, f.remoteId);
  } finally { await f.dispose(); }
});

test('checkpoint journals and reconciles a lost response without duplicating backlog comments', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Checkpoint recovery', 'quick');
    await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true });
    f.remote.loseNextWriteResponse = true;
    const input = { name: 'Verified implementation', summary: 'Focused tests passed' };
    await assert.rejects(syncCheckpoint(f.root, change.id, input, { server: f.server, fetch: f.fetcher }), /simulated lost response/);
    const journal = JSON.parse(await readFile(path.join(f.root, '.notchlet', '.local', 'sync', `${change.id}.checkpoint.operation.json`), 'utf8'));
    assert.equal(f.remote.checkpointComments.length, 1);
    const result = await syncCheckpoint(f.root, change.id, input, { server: f.server, fetch: f.fetcher });
    assert.equal(result.state, 'checkpointed');
    assert.equal(f.remote.checkpointComments.length, 1);
    assert.ok(f.remote.requests.some(r => r.path === `/development/v1/operations/${journal.operationId}`));
  } finally { await f.dispose(); }
});

test('pending connected writes survive offline and revoked access, then reconnect from the journal', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Offline reconnect', 'quick');
    f.remote.loseNextWriteResponse = true;
    await assert.rejects(syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true }), /simulated lost response/);
    const journalPath = path.join(f.root, '.notchlet', '.local', 'sync', `${change.id}.create.operation.json`);
    const savedJournal = await readFile(journalPath, 'utf8');

    const offlineFetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    await assert.rejects(syncPush(f.root, change.id, { server: f.server, fetch: offlineFetch, yes: true }), /offline/);
    assert.equal((await syncStatus(f.root, change.id)).state, 'local-only');
    assert.equal(await readFile(journalPath, 'utf8'), savedJournal);

    const revokedFetch = (async () => new Response('', { status: 401 })) as typeof fetch;
    await assert.rejects(syncPush(f.root, change.id, { server: f.server, fetch: revokedFetch, yes: true }), /authenticate again/);
    assert.equal(await readFile(journalPath, 'utf8'), savedJournal);
    assert.equal(f.remote.requests.filter(r => r.path === '/development/v1/changes' && r.method === 'POST').length, 1);

    assert.equal((await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true })).state, 'pushed');
    assert.equal(f.remote.requests.filter(r => r.path === '/development/v1/changes' && r.method === 'POST').length, 1);
    const state = JSON.parse(await readFile(path.join(f.root, '.notchlet', '.local', 'sync', `${change.id}.json`), 'utf8'));
    assert.equal(state.capturedAt, '2026-01-01T00:00:00Z');
    await assert.rejects(readFile(journalPath));
  } finally { await f.dispose(); }
});

test('sync status distinguishes local-only; remote-only pull safely writes files and divergent edits remain untouched', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Sync pull', 'quick');
    assert.equal((await syncStatus(f.root, change.id)).state, 'local-only');
    assert.equal((await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true })).state, 'pushed');
    const proposal = path.join(f.root, '.notchlet', 'changes', change.id, 'proposal.json');
    const remotePackage = JSON.parse(Buffer.from(f.remote.content.get(f.remote.snapshots[0].id).content, 'base64').toString());
    remotePackage.artifacts['proposal.json'] = '# Remote edit\n';
    const bytes = Buffer.from(JSON.stringify(remotePackage)), hash = digest(bytes), id = '33333333-3333-4333-8333-333333333333';
    const snapshot = { ...f.remote.snapshots[0], id, revision: 2, sha256: hash, sizeBytes: bytes.length, changeRevision: f.remote.metadata.revision + 1 };
    f.remote.snapshots.unshift(snapshot); f.remote.content.set(id, { ...snapshot, content: bytes.toString('base64') }); f.remote.metadata.revision++;
    const pulled = await syncPull(f.root, change.id, { server: f.server, fetch: f.fetcher });
    assert.equal(pulled.state, 'pulled');
    assert.equal(await readFile(proposal, 'utf8'), '# Remote edit\n');
    const localState = JSON.parse(await readFile(path.join(f.root, '.notchlet', '.local', 'sync', `${change.id}.json`), 'utf8'));
    assert.equal(localState.baseHash, hash);
    remotePackage.artifacts['proposal.json'] = '# New remote\n';
    const nextBytes = Buffer.from(JSON.stringify(remotePackage)), nextId = '44444444-4444-4444-8444-444444444444';
    const next = { ...snapshot, id: nextId, revision: 3, sha256: digest(nextBytes), sizeBytes: nextBytes.length, changeRevision: f.remote.metadata.revision + 1 };
    f.remote.snapshots.unshift(next); f.remote.content.set(nextId, { ...next, content: nextBytes.toString('base64') }); f.remote.metadata.revision++;
    await writeFile(proposal, '# Unsynced local edit\n');
    const before = await readFile(proposal);
    const conflict = await syncPull(f.root, change.id, { server: f.server, fetch: f.fetcher });
    assert.equal(conflict.conflict, 'divergent_edits');
    assert.deepEqual(await readFile(proposal), before);
  } finally { await f.dispose(); }
});

test('sync conflict resolution requires a verified base, validates remote artifacts, and retries against the current revision', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Explicit conflict resolution', 'quick');
    await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true });
    const statePath = path.join(f.root, '.notchlet', '.local', 'sync', `${change.id}.json`);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const proposal = path.join(f.root, '.notchlet', 'changes', change.id, 'proposal.json');
    await writeFile(proposal, '# User reconciliation\n');

    const originalPackage = JSON.parse(Buffer.from(f.remote.content.get(f.remote.snapshots[0].id).content, 'base64').toString());
    const incompatiblePackage = structuredClone(originalPackage);
    incompatiblePackage.change.schemaVersion = '999.0.0';
    const incompatibleBytes = Buffer.from(JSON.stringify(incompatiblePackage));
    const incompatible = { ...f.remote.snapshots[0], id: '66666666-6666-4666-8666-666666666666', revision: 2, sha256: digest(incompatibleBytes), sizeBytes: incompatibleBytes.length, changeRevision: f.remote.metadata.revision + 1 };
    f.remote.snapshots.unshift(incompatible); f.remote.content.set(incompatible.id, { ...incompatible, content: incompatibleBytes.toString('base64') });
    f.remote.metadata = { ...f.remote.metadata, revision: incompatible.changeRevision, snapshotRevision: 2 };
    const postsBeforeInvalid = f.remote.requests.filter(r => r.method === 'POST' && r.path.endsWith('/snapshots')).length;
    const invalid = await syncResolve(f.root, change.id, 'keep-local', { server: f.server, fetch: f.fetcher });
    assert.equal(invalid.conflict, 'incompatible_remote_snapshot');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).baseHash, state.baseHash);
    assert.equal(f.remote.requests.filter(r => r.method === 'POST' && r.path.endsWith('/snapshots')).length, postsBeforeInvalid);

    // Restore a valid current snapshot and prove the resolver refuses absent base metadata.
    const validRemotePackage = structuredClone(originalPackage);
    validRemotePackage.artifacts['proposal.json'] = '# Other client edit\n';
    const validBytes = Buffer.from(JSON.stringify(validRemotePackage));
    const valid = { ...incompatible, id: '77777777-7777-4777-8777-777777777777', revision: 3, sha256: digest(validBytes), sizeBytes: validBytes.length, changeRevision: f.remote.metadata.revision + 1 };
    f.remote.snapshots.unshift(valid); f.remote.content.set(valid.id, { ...valid, content: validBytes.toString('base64') });
    f.remote.metadata = { ...f.remote.metadata, revision: valid.changeRevision, snapshotRevision: 3 };
    const { baseHash: _baseHash, ...missingBase } = state;
    await writeFile(statePath, JSON.stringify(missingBase));
    const missing = await syncResolve(f.root, change.id, 'keep-local', { server: f.server, fetch: f.fetcher });
    assert.equal(missing.conflict, 'missing_sync_base');
    const postsBeforeMissingRetry = f.remote.requests.filter(r => r.method === 'POST' && r.path.endsWith('/snapshots')).length;
    assert.equal((await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true })).state, 'conflict');
    assert.equal(f.remote.requests.filter(r => r.method === 'POST' && r.path.endsWith('/snapshots')).length, postsBeforeMissingRetry);

    await writeFile(statePath, JSON.stringify(state));
    const resolved = await syncResolve(f.root, change.id, 'keep-local', { server: f.server, fetch: f.fetcher });
    assert.equal(resolved.state, 'resolved');
    assert.equal(await readFile(proposal, 'utf8'), '# User reconciliation\n');
    const latest = f.remote.snapshots[0];
    const revisionBeforePush = f.remote.metadata.revision;
    assert.equal(latest.revision, 3);
    const pushed = await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true });
    assert.equal(pushed.state, 'pushed');
    const snapshotPost = f.remote.requests.filter(r => r.method === 'POST' && r.path.endsWith('/snapshots')).at(-1)!;
    assert.equal(new Headers(snapshotPost.headers).get('If-Match'), `"${revisionBeforePush}"`);
  } finally { await f.dispose(); }
});

test('sync rejects oversized packages and mismatched remote identity before mutation', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Guard checks', 'quick');
    await writeFile(path.join(f.root, '.notchlet', 'changes', change.id, 'proposal.json'), 'x'.repeat(1_048_600));
    await assert.rejects(syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true }), /1 MiB/);
    await writeFile(path.join(f.root, '.notchlet', 'changes', change.id, 'proposal.json'), 'small');
    f.remote.caps = { ...syncCapabilities, server: { id: 'wrong-server', version: '1.0.0' } };
    await assert.rejects(syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true }), /identity/);
    assert.equal(f.remote.requests.filter(r => r.method === 'POST').length, 0);
  } finally { await f.dispose(); }
});

test('sync pull rejects traversal paths in remote artifact declarations without writing outside the change', async () => {
  const f = await syncFixture();
  try {
    const change = await scaffold(f.root, 'Traversal guard', 'quick');
    await syncPush(f.root, change.id, { server: f.server, fetch: f.fetcher, yes: true });
    const pkg = JSON.parse(Buffer.from(f.remote.content.get(f.remote.snapshots[0].id).content, 'base64').toString());
    pkg.change.artifacts['../../outside.txt'] = '../../outside.txt';
    pkg.artifacts['../../outside.txt'] = 'must not escape';
    const bytes = Buffer.from(JSON.stringify(pkg)), remoteSnapshotId = '55555555-5555-4555-8555-555555555555';
    const snapshot = { ...f.remote.snapshots[0], id: remoteSnapshotId, revision: 2, sha256: digest(bytes), sizeBytes: bytes.length, changeRevision: f.remote.metadata.revision + 1 };
    f.remote.snapshots.unshift(snapshot); f.remote.content.set(remoteSnapshotId, { ...snapshot, content: bytes.toString('base64') }); f.remote.metadata.revision++;
    await assert.rejects(syncPull(f.root, change.id, { server: f.server, fetch: f.fetcher }), /unsafe artifact path/);
    await assert.rejects(readFile(path.join(f.root, '.notchlet', 'outside.txt')));
  } finally { await f.dispose(); }
});

test('packed CLI child process pushes, checkpoints, pulls, and explicitly resolves connected sync', { timeout: 60_000 }, async (t) => {
  const f = await syncFixture();
  t.after(() => f.dispose());
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const bridge = createServer((req, res) => {
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', async () => {
      try {
        const response = await f.fetcher(`https://sync.example${req.url}`, {
          method: req.method,
          headers: req.headers as HeadersInit,
          ...(body ? { body } : {}),
        });
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
  });
  t.after(async () => {
    bridge.closeAllConnections();
    await new Promise<void>(resolve => bridge.close(() => resolve()));
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const address = bridge.address(); assert(address && typeof address !== 'string');
  const preload = path.join(f.root, 'loopback-fetch.mjs');
  await writeFile(preload, `const nativeFetch = globalThis.fetch.bind(globalThis); globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); if (url.origin !== 'https://sync.example') throw new Error('Unexpected external request: ' + url.origin); return nativeFetch('http://127.0.0.1:${address.port}' + url.pathname + url.search, init); };`);
  const packedEnv = { ...process.env };
  const run = async (...args: string[]) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args, '--json'], { cwd: f.root, env: packedEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    const result = await new Promise<{ code: number | null; error?: Error }>(resolve => {
      child.once('error', error => resolve({ code: null, error }));
      child.once('close', code => resolve({ code }));
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.code, 0, `${args.join(' ')} failed\n${stdout}\n${stderr}`);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true, stdout);
    return envelope.data;
  };
  try {
    const change = await scaffold(f.root, 'Packed connected route', 'quick');
    const proposal = path.join(f.root, '.notchlet', 'changes', change.id, 'proposal.json');
    await writeFile(proposal, '# Local version\n');

    assert.equal((await run('sync', 'push', '--change', change.id, '--yes', '--endpoint', f.server)).state, 'pushed');
    assert.equal(f.remote.snapshots.length, 1);
    const initial = JSON.parse(Buffer.from(f.remote.content.get(f.remote.snapshots[0].id).content, 'base64').toString());
    assert.equal(initial.artifacts['proposal.json'], '# Local version\n');
    assert.equal((await run('sync', 'status', '--change', change.id, '--endpoint', f.server)).state, 'unchanged');
    assert.equal((await run('checkpoint', '--change', change.id, '--name', 'Packed checkpoint', '--summary', 'Process route checked', '--endpoint', f.server)).state, 'checkpointed');
    assert.equal(f.remote.checkpointComments.length, 1);

    const remotePackage = structuredClone(initial);
    remotePackage.artifacts['proposal.json'] = '# Remote version\n';
    const bytes = Buffer.from(JSON.stringify(remotePackage));
    const remoteId = '33333333-3333-4333-8333-333333333333';
    const remoteSnapshot = { ...f.remote.snapshots[0], id: remoteId, revision: 2, sha256: digest(bytes), sizeBytes: bytes.length, changeRevision: f.remote.metadata.revision + 1 };
    f.remote.snapshots.unshift(remoteSnapshot);
    f.remote.content.set(remoteId, { ...remoteSnapshot, content: bytes.toString('base64') });
    f.remote.metadata = { ...f.remote.metadata, revision: remoteSnapshot.changeRevision, snapshotRevision: 2 };
    assert.equal((await run('sync', 'pull', '--change', change.id)).state, 'pulled');
    assert.equal(await readFile(proposal, 'utf8'), '# Remote version\n');
    remotePackage.artifacts['proposal.json'] = '# Newer remote version\n';
    const newerBytes = Buffer.from(JSON.stringify(remotePackage));
    const newerId = '44444444-4444-4444-8444-444444444444';
    const newerSnapshot = { ...remoteSnapshot, id: newerId, revision: 3, sha256: digest(newerBytes), sizeBytes: newerBytes.length, changeRevision: f.remote.metadata.revision + 1 };
    f.remote.snapshots.unshift(newerSnapshot);
    f.remote.content.set(newerId, { ...newerSnapshot, content: newerBytes.toString('base64') });
    f.remote.metadata = { ...f.remote.metadata, revision: newerSnapshot.changeRevision, snapshotRevision: 3 };
    await writeFile(proposal, '# Divergent local version\n');
    assert.equal((await run('sync', 'status', '--change', change.id, '--endpoint', f.server)).state, 'divergent');
    const beforePull = await readFile(proposal, 'utf8');
    const pull = await run('sync', 'pull', '--change', change.id, '--endpoint', f.server);
    assert.equal(pull.conflict, 'divergent_edits');
    assert.equal(await readFile(proposal, 'utf8'), beforePull);
    assert.equal(f.remote.snapshots.length, 3);

    assert.equal((await run('sync', 'resolve', '--change', change.id, '--keep-local', '--endpoint', f.server)).state, 'resolved');
    assert.equal(await readFile(proposal, 'utf8'), '# Divergent local version\n');
    assert.equal(f.remote.snapshots.length, 3, 'resolution itself does not write a duplicate snapshot');
    assert.equal(f.remote.checkpointComments.length, 1, 'checkpoint is not duplicated');
    const pushed = await run('sync', 'push', '--change', change.id, '--yes', '--endpoint', f.server);
    assert.equal(pushed.state, 'pushed');
    assert.equal(f.remote.snapshots.length, 4);
    const reconciled = JSON.parse(Buffer.from(f.remote.content.get(f.remote.snapshots[0].id).content, 'base64').toString());
    assert.equal(reconciled.artifacts['proposal.json'], '# Divergent local version\n');
  } finally {
    bridge.closeAllConnections();
  }
});
