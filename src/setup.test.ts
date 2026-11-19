import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { interactiveInit } from './setup.js';
import type { CredentialStore } from './auth.js';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('interactive init supports offline local mode without asking for credentials or making requests', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet-init-local-'));
  const root = path.join(parent, 'checkout'), prompts: string[] = [], output: string[] = [];
  const io = { async readLine(prompt: string) { prompts.push(prompt); return '1'; }, async readSecret() { throw new Error('local init must not ask for a password'); }, write(text: string) { output.push(text); } };
  let requests = 0;
  try {
    const result = await interactiveInit(root, { io, fetch: (async () => { requests++; throw new Error('offline'); }) as typeof fetch });
    assert.equal(result.mode, 'local');
    assert.equal(result.initialized, true);
    assert.deepEqual(prompts, ['Choose 1-2 [1]: ']);
    assert.ok(output.some(text => /Local-only \(offline; no account login\)/.test(text)));
    assert.equal(requests, 0);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'))).sort(), ['createdAt', 'schemaVersion']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('interactive init logs in, presents account catalog choices, binds the selected Git repository, and saves sync preference', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet-init-connected-'));
  const root = path.join(parent, 'checkout');
  const old = {
    config: process.env.NOTCHLET_CONFIG_DIR,
    token: process.env.NOTCHLET_TOKEN,
    email: process.env.NOTCHLET_EMAIL,
    password: process.env.NOTCHLET_PASSWORD,
    server: process.env.NOTCHLET_SERVER,
  };
  process.env.NOTCHLET_CONFIG_DIR = path.join(parent, 'config');
  delete process.env.NOTCHLET_TOKEN; delete process.env.NOTCHLET_EMAIL; delete process.env.NOTCHLET_PASSWORD; delete process.env.NOTCHLET_SERVER;
  await import('node:fs/promises').then(fs => fs.mkdir(root, { recursive: true }));
  git(root, 'init');
  git(root, 'remote', 'add', 'origin', 'https://github.com/acme/repo.git');
  const lineAnswers = ['2', 'https://cli.example.test', 'user@example.test', '1', '1', '1', ''];
  const prompts: string[] = [], secretPrompts: string[] = [], output: string[] = [], requests: Array<{ path: string; method: string; body?: any }> = [];
  const io = {
    async readLine(prompt: string) { prompts.push(prompt); return lineAnswers.shift() ?? ''; },
    async readSecret(prompt: string) { secretPrompts.push(prompt); return 'never-store-this-password'; },
    write(text: string) { output.push(text); },
  };
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'test OS credential store', async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); } };
  const accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const fetcher: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body });
    if (url.pathname === '/auth/login') return Response.json({ user: { email: body.email }, accessToken, refreshToken: 'refresh-token' });
    if (url.pathname === '/organizations/mine') return Response.json([{ id: 3, name: 'Team Org' }]);
    if (url.pathname === '/products') return Response.json([{ id: 10, name: 'Product', team: { name: 'Team' } }]);
    if (url.pathname === '/git/config') return Response.json([{ id: 20, productId: 10, repoLabel: 'acme/repo', provider: 'GITHUB', repoOwner: 'acme', repoName: 'repo', serverUrl: null }]);
    if (url.pathname === '/development/v1/capabilities') return Response.json({ server: { id: 'stable-server', version: '1.0.0' }, protocol: { minimum: '1.0', maximum: '1.0' }, versions: { core: '0.1.0', schema: '1.0.0' }, limits: { snapshotUploadBytes: 1048576 }, operations: ['createChange', 'uploadSnapshot'] });
    if (url.pathname === '/products/10') return Response.json({ id: 10, name: 'Product' });
    throw new Error(`Unexpected setup API request: ${url.pathname}${url.search}`);
  });
  try {
    const result = await interactiveInit(root, { io, fetch: fetcher, store });
    assert.equal(result.mode, 'connected');
    assert.equal(result.syncMode, 'auto');
    assert.deepEqual(prompts, [
      'Choose 1-2 [1]: ',
      'Notchlet server HTTPS origin: ',
      'Notchlet email: ',
      'Choose 1-1 [1]: ',
      'Choose 1-1 [1]: ',
      'Choose 1-1 [1]: ',
      'Choose 1-2 [1]: ',
    ]);
    assert.deepEqual(secretPrompts, ['Notchlet password (input hidden): ']);
    assert.ok(output.some(text => text.includes('Organizations:')));
    assert.ok(output.some(text => text.includes('Products:')));
    assert.ok(output.some(text => text.includes('Repositories:')));
    const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    assert.equal(workspace.preferences.syncMode, 'auto');
    assert.deepEqual({ server: workspace.binding.server, productId: workspace.binding.productId, repositoryId: workspace.binding.repositoryId, repositoryRemote: workspace.binding.repositoryRemote }, { server: 'https://cli.example.test', productId: 10, repositoryId: 20, repositoryRemote: 'github.com/acme/repo' });
    assert.deepEqual(requests.filter(request => request.path.startsWith('/organizations') || request.path.startsWith('/products') || request.path.startsWith('/git/config')).map(request => request.path), [
      '/organizations/mine', '/products?organizationId=3', '/git/config?productId=10', '/products/10', '/git/config?productId=10',
    ]);
    assert.doesNotMatch(JSON.stringify(workspace), /never-store-this-password|refresh-token|signature/);
  } finally {
    if (old.config === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = old.config;
    if (old.token === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = old.token;
    if (old.email === undefined) delete process.env.NOTCHLET_EMAIL; else process.env.NOTCHLET_EMAIL = old.email;
    if (old.password === undefined) delete process.env.NOTCHLET_PASSWORD; else process.env.NOTCHLET_PASSWORD = old.password;
    if (old.server === undefined) delete process.env.NOTCHLET_SERVER; else process.env.NOTCHLET_SERVER = old.server;
    await rm(parent, { recursive: true, force: true });
  }
});
