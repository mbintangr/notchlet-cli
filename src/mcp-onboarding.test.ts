import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serverKey, type CredentialStore } from './auth.js';
import type { Fetcher } from './integration.js';
import { mcpStatus, mcpDisconnect, mcpRevoke, setupMcpAccess } from './mcp-onboarding.js';

class MemoryStore implements CredentialStore {
  name = 'test credential store';
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

const origin = 'https://mcp.example.test';
const secretValue = 'mcp_live_onboarding_secret';

function accessToken() {
  return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
}

async function seedAccount(store: MemoryStore, root: string) {
  const config = path.join(root, '..', 'config');
  process.env.NOTCHLET_CONFIG_DIR = config;
  await mkdir(config, { recursive: true });
  const key = serverKey(origin);
  await store.set(key, JSON.stringify({ kind: 'notchlet-user-session', accessToken: accessToken(), refreshToken: 'refresh', email: 'user@example.test' }));
  await writeFile(path.join(config, 'profiles.json'), `${JSON.stringify({ schemaVersion: 1, current: key, profiles: { [key]: { origin, serverIdentity: origin, authMode: 'user', email: 'user@example.test', credentialStore: 'os' } } }, null, 2)}\n`);
  return key;
}

type Call = { method: string; path: string; body?: any };

function fakeFetch(handler: (url: URL, init: RequestInit) => Response | undefined) {
  const calls: Call[] = [];
  const fetcher: Fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ method: init.method ?? 'GET', path: url.pathname, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const response = handler(url, init);
    if (!response) throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${url.pathname}`);
    return response;
  }) as Fetcher;
  return { fetcher, calls };
}

async function tempCheckout() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet-mcp-onboarding-'));
  const root = path.join(parent, 'checkout');
  await mkdir(root, { recursive: true });
  return { parent, root };
}

test('MCP setup refuses token-only credentials before touching account settings or configuration', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  const { fetcher, calls } = fakeFetch(() => undefined);
  let confirmations = 0;
  const previousToken = process.env.NOTCHLET_TOKEN;
  try {
    await seedAccount(store, root);
    process.env.NOTCHLET_TOKEN = 'scoped-api-token';
    await assert.rejects(
      setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async () => { confirmations++; return true; } }),
      /requires an account login session/,
    );
    assert.equal(calls.length, 0);
    assert.equal(confirmations, 0);
    await assert.rejects(readFile(path.join(root, 'opencode.json'), 'utf8'), /ENOENT/);
  } finally {
    if (previousToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = previousToken;
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('declining the account-wide MCP enable leaves the account, keyring, and project configuration unchanged', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  const { fetcher, calls } = fakeFetch(url => url.pathname === '/mcp/settings' ? Response.json({ enabled: false }) : undefined);
  let prompts: string[] = [];
  try {
    await seedAccount(store, root);
    const result = await setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async message => { prompts.push(message); return false; } });
    assert.equal(result.status, 'declined');
    assert.match(result.message ?? '', /not changed/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /account-wide/);
    assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), ['GET /mcp/settings']);
    assert.equal(store.values.size, 1);
    await assert.rejects(readFile(path.join(root, 'opencode.json'), 'utf8'), /ENOENT/);
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('approving enablement creates one least-privilege credential, stores it apart from the session, and writes secret-free configuration', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  const { fetcher, calls } = fakeFetch((url, init) => {
    if (url.pathname === '/mcp/settings' && (init.method ?? 'GET') === 'GET') return Response.json({ enabled: false });
    if (url.pathname === '/mcp/settings' && init.method === 'PUT') return Response.json({ enabled: true });
    if (url.pathname === '/mcp/settings/credentials' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 501, name: body.name, scopes: body.scopes, createdAt: '2026-01-01T00:00:00.000Z', secret: secretValue });
    }
    return undefined;
  });
  try {
    const sessionKey = await seedAccount(store, root);
    const result = await setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 7 }) });
    assert.equal(result.status, 'configured');
    assert.equal(result.toolCount, 7);
    assert.deepEqual(result.scopes, ['workspace:read', 'backlog:write', 'changes:write']);
    assert.equal(result.credentialId, 501);
    assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), ['GET /mcp/settings', 'PUT /mcp/settings', 'POST /mcp/settings/credentials']);
    assert.deepEqual(calls[1].body, { enabled: true });
    assert.deepEqual(calls[2].body.scopes, ['workspace:read', 'backlog:write', 'changes:write']);
    assert.match(calls[2].body.name, /^notchlet-opencode-[0-9a-f]{12}$/);

    const mcpKey = [...store.values.keys()].find(key => key !== sessionKey);
    assert.ok(mcpKey?.startsWith('mcp:'));
    assert.equal(store.values.get(mcpKey!), secretValue);
    assert.notEqual(store.values.get(sessionKey), secretValue);

    const config = await readFile(path.join(root, 'opencode.json'), 'utf8');
    assert.match(config, /"notchlet"/);
    assert.doesNotMatch(config, new RegExp(secretValue));
    const state = await readFile(path.join(root, '.notchlet', '.local', 'mcp.json'), 'utf8');
    assert.match(state, /"entryHash"/);
    assert.doesNotMatch(state, new RegExp(secretValue));
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('the broader scope preset is an explicit opt-in that replaces a narrower generated credential', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  let created = 0;
  const revoked: number[] = [];
  const { fetcher, calls } = fakeFetch((url, init) => {
    if (url.pathname === '/mcp/settings') return Response.json({ enabled: true });
    if (url.pathname === '/mcp/settings/credentials' && init.method === 'POST') {
      created++;
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 1000 + created, name: body.name, scopes: body.scopes, secret: `${secretValue}-${created}` });
    }
    if (url.pathname.startsWith('/mcp/settings/credentials/') && init.method === 'DELETE') {
      revoked.push(Number(url.pathname.split('/').pop()));
      return Response.json({ success: true });
    }
    return undefined;
  });
  try {
    await seedAccount(store, root);
    const recommended = await setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 1 }) });
    assert.equal(recommended.scopePreset, 'recommended');
    assert.deepEqual(recommended.scopes, ['workspace:read', 'backlog:write', 'changes:write']);

    const broaderScopes = ['workspace:read', 'backlog:write', 'changes:write', 'documents:write', 'tickets:write', 'generation:run', 'issues:sync'];
    const broader = await setupMcpAccess({ root, server: origin, client: 'opencode', scopePreset: 'broader', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 1 }) });
    assert.equal(broader.scopePreset, 'broader');
    assert.deepEqual(broader.scopes, broaderScopes);
    const posts = calls.filter(call => call.path === '/mcp/settings/credentials' && call.method === 'POST');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body.scopes, broaderScopes);
    assert.deepEqual(revoked, [1001]);
    assert.equal([...store.values.values()].filter(value => value.startsWith(secretValue)).length, 1);
    const state = JSON.parse(await readFile(path.join(root, '.notchlet', '.local', 'mcp.json'), 'utf8'));
    assert.deepEqual(state.servers[origin].credential.scopes, broaderScopes);
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('returning to recommended scopes rotates and revokes a previously broader credential', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  let created = 0;
  const revoked: number[] = [];
  const { fetcher } = fakeFetch((url, init) => {
    if (url.pathname === '/mcp/settings') return Response.json({ enabled: true });
    if (url.pathname === '/mcp/settings/credentials' && init.method === 'POST') {
      created++;
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 1100 + created, name: body.name, scopes: body.scopes, secret: `${secretValue}-${created}` });
    }
    if (url.pathname.startsWith('/mcp/settings/credentials/') && init.method === 'DELETE') {
      revoked.push(Number(url.pathname.split('/').pop()));
      return Response.json({ success: true });
    }
    return undefined;
  });
  try {
    await seedAccount(store, root);
    await setupMcpAccess({ root, server: origin, client: 'opencode', scopePreset: 'broader', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 1 }) });
    const recommended = await setupMcpAccess({ root, server: origin, client: 'opencode', scopePreset: 'recommended', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 1 }) });

    assert.equal(created, 2);
    assert.deepEqual(revoked, [1101]);
    assert.deepEqual(recommended.scopes, ['workspace:read', 'backlog:write', 'changes:write']);
    assert.equal([...store.values.values()].filter(value => value.startsWith(secretValue)).length, 1);
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('repeated setup reuses the stored credential and does not create duplicates', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  let created = 0;
  const { fetcher, calls } = fakeFetch((url, init) => {
    if (url.pathname === '/mcp/settings') return Response.json({ enabled: true });
    if (url.pathname === '/mcp/settings/credentials' && init.method === 'POST') {
      created++;
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 600 + created, name: body.name, scopes: body.scopes, secret: `${secretValue}-${created}` });
    }
    return undefined;
  });
  try {
    await seedAccount(store, root);
    const first = await setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 3 }) });
    const second = await setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 3 }) });
    assert.equal(first.credentialId, 601);
    assert.equal(second.credentialId, 601);
    assert.equal(created, 1);
    assert.equal(calls.filter(call => call.path === '/mcp/settings/credentials' && call.method === 'POST').length, 1);
    assert.equal([...store.values.values()].filter(value => value.startsWith(secretValue)).length, 1);
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('an unmanaged project entry produces a conflict without any account mutation', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  const { fetcher, calls } = fakeFetch(() => undefined);
  let confirmations = 0;
  try {
    await seedAccount(store, root);
    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ mcp: { notchlet: { type: 'remote', url: 'https://custom' } } }, null, 2)}\n`);
    const result = await setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async () => { confirmations++; return true; } });
    assert.equal(result.status, 'conflict');
    assert.match(result.message ?? '', /preserved/);
    assert.equal(calls.length, 0);
    assert.equal(confirmations, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8')).mcp.notchlet, { type: 'remote', url: 'https://custom' });
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('status reports configuration drift and redacts the account-session failure', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  const { fetcher } = fakeFetch((url, init) => {
    if (url.pathname === '/mcp/settings') return Response.json({ enabled: true });
    if (url.pathname === '/mcp/settings/credentials' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 701, name: body.name, scopes: body.scopes, secret: secretValue });
    }
    return undefined;
  });
  try {
    await seedAccount(store, root);
    await setupMcpAccess({ root, server: origin, client: 'claude', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 4 }) });

    const healthyFetcher: Fetcher = (async () => Response.json({ enabled: true })) as Fetcher;
    const healthy = await mcpStatus({ root, store, fetch: healthyFetcher });
    assert.equal(healthy.servers.length, 1);
    assert.equal(healthy.servers[0].credential?.keyring, 'present');
    assert.equal(healthy.servers[0].clients[0].client, 'claude');
    assert.equal(healthy.servers[0].clients[0].state, 'configured');
    assert.equal(healthy.servers[0].account?.enabled, true);

    const unauthorized: Fetcher = (async () => new Response('unauthorized', { status: 401 })) as Fetcher;
    const report = await mcpStatus({ root, store, fetch: unauthorized });
    assert.equal(report.servers[0].account?.enabled, null);
    assert.match(report.servers[0].account?.error ?? '', /rejected/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secretValue));

    const configPath = path.join(root, '.mcp.json');
    const value = JSON.parse(await readFile(configPath, 'utf8'));
    value.mcpServers.notchlet = { type: 'stdio', command: 'notchlet', args: ['mcp', 'serve', '--server', 'https://other.example.test'], env: {} };
    await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
    const drifted = await mcpStatus({ root, store, fetch: healthyFetcher });
    assert.equal(drifted.servers[0].clients[0].state, 'modified');
    assert.match(drifted.servers[0].clients[0].reason ?? '', /differs/);
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('disconnect cancels without confirmation, then removes only the Notchlet entry and optionally revokes', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  let deletes = 0;
  const { fetcher } = fakeFetch((url, init) => {
    if (url.pathname === '/mcp/settings') return Response.json({ enabled: true });
    if (url.pathname === '/mcp/settings/credentials' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 801, name: body.name, scopes: body.scopes, secret: secretValue });
    }
    if (url.pathname === '/mcp/settings/credentials/801' && init.method === 'DELETE') { deletes++; return Response.json({ success: true }); }
    return undefined;
  });
  try {
    await seedAccount(store, root);
    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);
    await setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 1 }) });

    const cancelled = await mcpDisconnect({ root, store, fetch: fetcher, confirm: async () => false });
    assert.match(cancelled.message ?? '', /Cancelled/);
    assert.ok(JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8')).mcp.notchlet);

    const removed = await mcpDisconnect({ root, store, fetch: fetcher, yes: true, confirm: async () => true });
    assert.equal(removed.removed[0].action, 'removed');
    assert.equal(removed.credential?.revoked, false);
    assert.equal(removed.credential?.keyring, 'kept');
    const config = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(config.theme, 'dark');
    assert.equal(config.mcp.notchlet, undefined);
    const stateAfterRemoval = JSON.parse(await readFile(path.join(root, '.notchlet', '.local', 'mcp.json'), 'utf8'));
    assert.deepEqual(stateAfterRemoval.servers[origin].clients, {});
    assert.ok([...store.values.keys()].some(key => key.startsWith('mcp:')));

    const revoked = await mcpDisconnect({ root, store, fetch: fetcher, yes: true, revoke: true, confirm: async () => true });
    assert.equal(revoked.credential?.revoked, true);
    assert.equal(revoked.credential?.keyring, 'removed');
    assert.equal(deletes, 1);
    assert.equal([...store.values.keys()].some(key => key.startsWith('mcp:')), false);
    const finalState = JSON.parse(await readFile(path.join(root, '.notchlet', '.local', 'mcp.json'), 'utf8'));
    assert.deepEqual(finalState.servers, {});
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('revoke deletes the remote credential and local secret and tolerates an already-revoked credential', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  let deletes = 0;
  let deleteStatus = 200;
  const { fetcher } = fakeFetch((url, init) => {
    if (url.pathname === '/mcp/settings') return Response.json({ enabled: true });
    if (url.pathname === '/mcp/settings/credentials' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 901, name: body.name, scopes: body.scopes, secret: secretValue });
    }
    if (url.pathname === '/mcp/settings/credentials/901' && init.method === 'DELETE') {
      deletes++;
      return deleteStatus === 200 ? Response.json({ success: true }) : new Response('missing', { status: deleteStatus });
    }
    return undefined;
  });
  try {
    await seedAccount(store, root);
    await setupMcpAccess({ root, server: origin, client: 'opencode', store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 1 }) });

    const result = await mcpRevoke({ root, server: origin, store, fetch: fetcher, yes: true, confirm: async () => true });
    assert.equal(result.revoked, true);
    assert.equal(result.keyring, 'removed');
    assert.equal(deletes, 1);
    assert.equal([...store.values.keys()].some(key => key.startsWith('mcp:')), false);

    const state = JSON.parse(await readFile(path.join(root, '.notchlet', '.local', 'mcp.json'), 'utf8'));
    assert.deepEqual(state.servers, {});

    deleteStatus = 404;
    const again = await mcpRevoke({ root, server: origin, credentialId: 901, store, fetch: fetcher, yes: true, confirm: async () => true });
    assert.equal(again.revoked, false);
    assert.match(again.message ?? '', /already revoked/);
    assert.equal(deletes, 2);
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});

test('remote transport writes a direct HTTP entry with an environment token reference and records the transport', async () => {
  const { parent, root } = await tempCheckout();
  const store = new MemoryStore();
  const { fetcher } = fakeFetch((url, init) => {
    if (url.pathname === '/mcp/settings' && (init.method ?? 'GET') === 'GET') return Response.json({ enabled: true });
    if (url.pathname === '/mcp/settings/credentials' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Response.json({ id: 601, name: body.name, scopes: body.scopes, createdAt: '2026-01-01T00:00:00.000Z', secret: secretValue });
    }
    return undefined;
  });
  try {
    await seedAccount(store, root);
    const result = await setupMcpAccess({
      root, server: origin, client: 'opencode', transport: 'remote', tokenEnv: 'ACME_MCP_TOKEN',
      store, fetch: fetcher, confirmEnable: async () => true, verify: async () => ({ toolCount: 9 }),
    });
    assert.equal(result.status, 'configured');
    assert.equal(result.transport, 'remote');
    assert.equal(result.tokenEnv, 'ACME_MCP_TOKEN');
    const config = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.deepEqual(config.mcp.notchlet, {
      type: 'remote',
      url: `${origin}/mcp`,
      headers: { Authorization: 'Bearer {env:ACME_MCP_TOKEN}' },
    });
    assert.doesNotMatch(JSON.stringify(config), new RegExp(secretValue));
    const state = JSON.parse(await readFile(path.join(root, '.notchlet', '.local', 'mcp.json'), 'utf8'));
    assert.equal(state.servers[origin].clients.opencode.transport, 'remote');
    const report = await mcpStatus({ root, store, fetch: fetcher });
    assert.equal(report.servers[0].transport, 'remote');
    assert.equal(report.servers[0].clients[0].state, 'configured');
  } finally {
    delete process.env.NOTCHLET_CONFIG_DIR;
    await rm(parent, { recursive: true, force: true });
  }
});
