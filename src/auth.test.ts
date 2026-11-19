import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { assertFileFallbackSupported, authCommand, configDir, fileCredentialStore, normalizeOrigin, osCredentialStore, readHiddenToken, resolveCredential, serverKey, type CredentialStore } from './auth.js';

test('uses platform-specific default config roots and honors the explicit config override', () => {
  const keys = ['NOTCHLET_CONFIG_DIR', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.NOTCHLET_CONFIG_DIR = path.join(os.tmpdir(), 'notchlet override');
    assert.equal(configDir(), path.join(os.tmpdir(), 'notchlet override'));
    delete process.env.NOTCHLET_CONFIG_DIR;
    if (process.platform === 'win32') {
      process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'Local App Data');
      assert.equal(configDir(), path.join(process.env.LOCALAPPDATA, 'Notchlet'));
    } else {
      process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), 'XDG Config');
      assert.equal(configDir(), path.join(process.env.XDG_CONFIG_HOME, 'notchlet'));
    }
  } finally {
    for (const key of keys) {
      const value = old[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('normalizes server origins and rejects non-origin URLs', () => {
  assert.equal(normalizeOrigin('https://Example.com:443/'), 'https://example.com');
  assert.throws(() => normalizeOrigin('http://example.com'));
  assert.throws(() => normalizeOrigin('https://user:secret@example.com'));
  assert.throws(() => normalizeOrigin('https://example.com/api'));
});

test('profiles switch servers without exposing secrets and logout only removes selected server', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'test OS store', async get(k) { return values.get(k); }, async set(k,v) { values.set(k,v); }, async delete(k) { values.delete(k); } };
  try {
    await authCommand('login', { server: 'https://one.example', store, token: 'secret-one' });
    await authCommand('login', { server: 'https://two.example', store, token: 'secret-two' });
    const profiles = await readFile(path.join(dir, 'profiles.json'), 'utf8');
    assert.doesNotMatch(profiles, /secret-one|secret-two/);
    assert.equal((await authCommand('status', { server: 'https://one.example', store })).credential.source, 'test OS store');
    const logout = await authCommand('logout', { server: 'https://one.example', store });
    assert.equal(logout.loggedOut, true);
    assert.equal(values.has(serverKey('https://one.example')), false);
    assert.equal(values.get(serverKey('https://two.example')), 'secret-two');
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('environment token takes precedence, is never persisted, and status redacts it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-env-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; process.env.NOTCHLET_TOKEN = 'environment-secret';
  try {
    const result = await authCommand('login', { server: 'https://env.example', json: true });
    assert.deepEqual(result.credential, { source: 'environment', status: 'available' });
    assert.doesNotMatch(await readFile(path.join(dir, 'profiles.json'), 'utf8'), /environment-secret/);
    const status = await authCommand('status', { server: 'https://env.example' });
    assert.equal(JSON.stringify(status).includes('environment-secret'), false);
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveCredential uses environment precedence and otherwise resolves only selected profile storage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-resolve-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'mock keyring', async get(k) { return values.get(k); }, async set(k,v) { values.set(k,v); }, async delete(k) { values.delete(k); } };
  try {
    await authCommand('login', { server: 'https://one.example', token: 'profile-token', store });
    await authCommand('login', { server: 'https://two.example', token: 'other-token', store });
    process.env.NOTCHLET_TOKEN = 'environment-token';
    assert.equal((await resolveCredential({ server: 'https://one.example', store })).token, 'environment-token');
    delete process.env.NOTCHLET_TOKEN;
    assert.equal((await resolveCredential({ store })).token, 'other-token');
    assert.equal((await resolveCredential({ server: 'https://one.example', store })).token, 'profile-token');
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSON mode refuses interactive login before any secret prompt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-json-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  try { await assert.rejects(authCommand('login', { server: 'https://json.example', json: true }), /disabled in JSON mode/); }
  finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('email/password login stores returned access and refresh tokens only in the credential store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-password-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'mock OS keychain', async get(k) { return values.get(k); }, async set(k, v) { values.set(k, v); }, async delete(k) { values.delete(k); } };
  const futureAccess = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  let request: any;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { url: String(input), init, body: JSON.parse(String(init?.body)) };
    return Response.json({ user: { id: 21, email: 'person@example.test' }, accessToken: futureAccess, refreshToken: 'refresh-secret' });
  }) as typeof fetch;
  try {
    const result = await authCommand('login', { server: 'https://platform.example', email: 'person@example.test', password: 'password-secret', fetch: fetcher, store });
    assert.equal(request.url, 'https://platform.example/auth/login');
    assert.equal(request.init.method, 'POST');
    assert.deepEqual(request.body, { email: 'person@example.test', password: 'password-secret' });
    assert.deepEqual(result.profile, { origin: 'https://platform.example', serverIdentity: 'https://platform.example', authMode: 'user', email: 'person@example.test', credentialStore: 'os' });
    assert.doesNotMatch(await readFile(path.join(dir, 'profiles.json'), 'utf8'), /password-secret|refresh-secret|signature/);
    const saved = JSON.parse(values.get(serverKey('https://platform.example'))!);
    assert.equal(saved.kind, 'notchlet-user-session');
    assert.equal(saved.accessToken, futureAccess);
    assert.equal(saved.refreshToken, 'refresh-secret');
    const resolved = await resolveCredential({ server: 'https://platform.example', store });
    assert.deepEqual({ token: resolved.token, refreshToken: resolved.refreshToken, authMode: resolved.authMode }, { token: futureAccess, refreshToken: 'refresh-secret', authMode: 'user' });
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('interactive login requests a visible email and a hidden password', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-prompts-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'mock OS keychain', async get(k) { return values.get(k); }, async set(k, v) { values.set(k, v); }, async delete(k) { values.delete(k); } };
  const prompts: string[] = [];
  const future = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  try {
    const result = await authCommand('login', {
      server: 'https://prompt.example', store,
      io: {
        async readLine(prompt) { prompts.push(prompt); return 'user@example.test'; },
        async readSecret(prompt) { prompts.push(prompt); return 'private-password'; },
      },
      fetch: (async () => Response.json({ user: { email: 'user@example.test' }, accessToken: future(Math.floor(Date.now() / 1000) + 3600), refreshToken: 'refresh' })) as typeof fetch,
    });
    assert.deepEqual(prompts, ['Notchlet email: ', 'Notchlet password (input hidden): ']);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'profiles.json'), 'utf8')).profiles[serverKey('https://prompt.example')].authMode, 'user');
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('an expired user access token rotates its refresh token and persists the replacement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-refresh-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'mock OS keychain', async get(k) { return values.get(k); }, async set(k, v) { values.set(k, v); }, async delete(k) { values.delete(k); } };
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
  await authCommand('login', { server: 'https://refresh.example', token: 'initial-scoped-token', store });
  await store.set(serverKey('https://refresh.example'), JSON.stringify({ kind: 'notchlet-user-session', accessToken: expired, refreshToken: 'old-refresh', email: 'person@example.test' }));
  let request: any;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { url: String(input), init };
    return Response.json({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  }) as typeof fetch;
  try {
    const resolved = await resolveCredential({ server: 'https://refresh.example', store, fetch: fetcher });
    assert.deepEqual({ token: resolved.token, refreshToken: resolved.refreshToken, authMode: resolved.authMode }, { token: 'new-access', refreshToken: 'new-refresh', authMode: 'user' });
    assert.equal(request.url, 'https://refresh.example/auth/refresh');
    assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer old-refresh');
    assert.equal(JSON.parse(values.get(serverKey('https://refresh.example'))!).refreshToken, 'new-refresh');
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('logout revokes only the selected user session before clearing its local credential', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-user-logout-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const values = new Map<string, string>();
  const store: CredentialStore = { name: 'mock OS keychain', async get(k) { return values.get(k); }, async set(k, v) { values.set(k, v); }, async delete(k) { values.delete(k); } };
  const accessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sid: 'session-1' })).toString('base64url')}.signature`;
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)} ${new Headers(init?.headers).get('authorization')}`);
    return Response.json({ user: { email: 'person@example.test' }, accessToken, refreshToken: 'refresh-token' });
  }) as typeof fetch;
  try {
    await authCommand('login', { server: 'https://logout.example', email: 'person@example.test', password: 'password', fetch: fetcher, store });
    const loggedOut = await authCommand('logout', { server: 'https://logout.example', fetch: fetcher, store });
    assert.equal(loggedOut.loggedOut, true);
    assert.equal(loggedOut.serverLogout, 'revoked');
    assert.match(requests[1], /^POST https:\/\/logout\.example\/auth\/logout Bearer header\./);
    assert.equal(values.has(serverKey('https://logout.example')), false);
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('uses the lazy OS provider for login, status, and logout without exposing its token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-provider-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const values = new Map<string, string>(); let loads = 0;
  const loadStore = async (): Promise<CredentialStore> => {
    loads++;
    return { name: 'mock OS keychain', async get(k) { return values.get(k); }, async set(k,v) { values.set(k,v); }, async delete(k) { values.delete(k); } };
  };
  try {
    const logged = await authCommand('login', { server: 'https://provider.example', token: 'private-token', loadStore });
    assert.deepEqual(logged.credential, { source: 'mock OS keychain', status: 'available' });
    assert.equal((await authCommand('status', { server: 'https://provider.example', loadStore })).credential.status, 'available');
    assert.equal(JSON.stringify(await readFile(path.join(dir, 'profiles.json'), 'utf8')).includes('private-token'), false);
    assert.equal((await authCommand('logout', { server: 'https://provider.example', loadStore })).loggedOut, true);
    assert.equal(values.size, 0);
    assert.equal(loads, 3);
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('keyring adapter awaits read, write, and delete methods and normalizes missing entries', async () => {
  const calls: string[] = [], values = new Map<string, string>();
  class FakeEntry {
    constructor(readonly service: string, readonly account: string) { calls.push(`entry:${service}:${account}`); }
    async getPassword() { calls.push('get'); return values.get(this.account) ?? null; }
    async setPassword(value: string) { calls.push('set:start'); await new Promise(resolve => setTimeout(resolve, 1)); values.set(this.account, value); calls.push('set:done'); }
    async deletePassword() { calls.push('delete:start'); await new Promise(resolve => setTimeout(resolve, 1)); values.delete(this.account); calls.push('delete:done'); }
  }
  const store = await osCredentialStore(async () => ({ Entry: FakeEntry }));
  assert.equal(await store.get('account'), undefined);
  await store.set('account', 'keyring-secret');
  assert.equal(await store.get('account'), 'keyring-secret');
  await store.delete('account');
  assert.equal(values.size, 0);
  assert.ok(calls.includes('set:done'));
  assert.ok(calls.includes('delete:done'));
});

test('keyring method failures propagate to explicit fallback without leaking native error messages', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-keyring-errors-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const error = new Error('secret-bearing keyring diagnostic');
  class BrokenEntry {
    constructor(readonly service: string, readonly account: string) {}
    async getPassword(): Promise<string | null> { throw error; }
    async setPassword(): Promise<void> { throw error; }
    async deletePassword(): Promise<boolean> { throw error; }
  }
  const loadStore = () => osCredentialStore(async () => ({ Entry: BrokenEntry }));
  try {
    const brokenAdapter = await loadStore();
    await assert.rejects(brokenAdapter.get('key'), /secret-bearing keyring diagnostic/);
    await assert.rejects(brokenAdapter.set('key', 'private'), /secret-bearing keyring diagnostic/);
    await assert.rejects(brokenAdapter.delete('key'), /secret-bearing keyring diagnostic/);
    await assert.rejects(authCommand('login', { server: 'https://broken.example', token: 'private', loadStore }), /explicitly pass --allow-file-token-store/);
    if (process.platform === 'win32') {
      await assert.rejects(authCommand('login', { server: 'https://broken.example', token: 'private', loadStore, allowFileStore: true }), /not supported on Windows/);
      assert.deepEqual(await readdir(dir), []);
      return;
    }
    const login = await authCommand('login', { server: 'https://broken.example', token: 'private', loadStore, allowFileStore: true });
    assert.match(login.credential.source, /restricted user file/);
    assert.doesNotMatch(JSON.stringify(login), /secret-bearing|private/);
    assert.equal((await authCommand('status', { server: 'https://broken.example', loadStore, allowFileStore: true })).credential.status, 'available');
    assert.equal((await authCommand('logout', { server: 'https://broken.example', loadStore, allowFileStore: true })).loggedOut, true);
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider failures require explicit fallback confirmation and fallback records redacted store choice', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-fallback-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = dir; delete process.env.NOTCHLET_TOKEN;
  const unavailable = async (): Promise<CredentialStore> => { throw new Error('native provider failure'); };
  try {
    await assert.rejects(authCommand('login', { server: 'https://fallback.example', token: 'secret', loadStore: unavailable }), /explicitly pass --allow-file-token-store/);
    if (process.platform === 'win32') {
      await assert.rejects(authCommand('login', { server: 'https://fallback.example', token: 'secret', loadStore: unavailable, allowFileStore: true }), /not supported on Windows/);
      assert.deepEqual(await readdir(dir), []);
      return;
    }
    const login = await authCommand('login', { server: 'https://fallback.example', token: 'secret', loadStore: unavailable, allowFileStore: true });
    assert.match(login.credential.source, /restricted user file/);
    const profileText = await readFile(path.join(dir, 'profiles.json'), 'utf8');
    assert.doesNotMatch(profileText, /secret/);
    assert.match(profileText, /"credentialStore": "file"/);
    await assert.rejects(authCommand('status', { server: 'https://fallback.example', loadStore: unavailable }), /--allow-file-token-store/);
    assert.equal((await authCommand('status', { server: 'https://fallback.example', loadStore: unavailable, allowFileStore: true })).credential.status, 'available');
    assert.equal((await authCommand('logout', { server: 'https://fallback.example', loadStore: unavailable, allowFileStore: true })).loggedOut, true);
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('restricted-file credential fallback writes secrets separately with restrictive permissions and rejects unsafe existing files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-auth-file-'));
  const oldDir = process.env.NOTCHLET_CONFIG_DIR; process.env.NOTCHLET_CONFIG_DIR = dir;
  try {
    assert.throws(() => assertFileFallbackSupported('win32'), /not supported on Windows/);
    if (process.platform === 'win32') {
      await assert.rejects(Promise.resolve().then(fileCredentialStore), /not supported on Windows/);
      await assert.rejects(authCommand('login', { server: 'https://fallback.example', token: 'private', allowFileStore: true, loadStore: async () => { throw new Error('missing'); } }), /not supported on Windows/);
      return;
    }
    const store = fileCredentialStore(); await store.set('server', 'file-secret');
    const secretFile = path.join(dir, 'credentials.json');
    assert.equal(await store.get('server'), 'file-secret');
    assert.deepEqual(await readdir(dir), ['credentials.json']);
    assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
    await writeFile(secretFile, '{');
    await assert.rejects(store.get('server'));
    await writeFile(secretFile, JSON.stringify({ server: 'file-secret' }));
    await chmod(secretFile, 0o644);
    await assert.rejects(store.get('server'), /permissions are too broad/);
  } finally {
    if (oldDir === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('hidden prompt accepts terminal input without echoing the token', async () => {
  const input = new EventEmitter() as EventEmitter & { isTTY: boolean; setRawMode: (enabled: boolean) => void; pause: () => void; resume: () => void };
  input.isTTY = true; const modes: boolean[] = [];
  input.setRawMode = enabled => { modes.push(enabled); }; input.pause = () => undefined; input.resume = () => undefined;
  let output = '';
  const pending = readHiddenToken({ stdin: input as never, stdout: { isTTY: true, write: (text: string) => { output += text; return true; } } as never });
  input.emit('data', Buffer.from('secret-token\r'));
  assert.equal(await pending, 'secret-token');
  assert.deepEqual(modes, [true, false]);
  assert.doesNotMatch(output, /secret-token/);
});
