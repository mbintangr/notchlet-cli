import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

export type CredentialStore = { name: string; get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
export type AuthIO = { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; readLine?: (prompt: string) => Promise<string>; readSecret?: (prompt: string) => Promise<string> };
export type AuthProfile = { origin: string; serverIdentity: string; credentialStore?: 'os' | 'file' | 'environment'; authMode?: 'user' | 'token'; email?: string };
type Profile = AuthProfile;
type Profiles = { schemaVersion: 1; current?: string; profiles: Record<string, Profile> };
type UserSession = { kind: 'notchlet-user-session'; accessToken: string; refreshToken: string; email: string };

export function normalizeOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Server must be a valid HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Server must be an HTTPS origin without credentials, path, query, or fragment.');
  return url.origin.toLowerCase();
}
export function serverKey(origin: string): string { return Buffer.from(origin).toString('base64url'); }
export function configDir(): string {
  if (process.env.NOTCHLET_CONFIG_DIR) return process.env.NOTCHLET_CONFIG_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Notchlet');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'notchlet');
}
function profilesPath(): string { return path.join(configDir(), 'profiles.json'); }

function parseUserSession(value: string): UserSession | null {
  try {
    const session = JSON.parse(value) as Partial<UserSession>;
    if (session.kind === 'notchlet-user-session' && typeof session.accessToken === 'string' && typeof session.refreshToken === 'string' && typeof session.email === 'string') return session as UserSession;
  } catch { /* existing installations may contain a raw scoped MCP token */ }
  return null;
}

function jwtExpiry(token: string): number | undefined {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch { return undefined; }
}

async function refreshUserSession(origin: string, session: UserSession, fetcher: typeof fetch): Promise<UserSession> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/auth/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${session.refreshToken}` } });
  } catch { throw new Error('Notchlet is unreachable while refreshing the login session.'); }
  if (!response.ok) throw new Error('Notchlet session expired or was revoked.');
  const tokens = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
  if (typeof tokens.accessToken !== 'string' || typeof tokens.refreshToken !== 'string') throw new Error('Notchlet returned an invalid refreshed session.');
  return { kind: 'notchlet-user-session', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, email: session.email };
}

async function readProfiles(): Promise<Profiles> {
  try {
    const value = JSON.parse(await readFile(profilesPath(), 'utf8')) as Profiles;
    if (value.schemaVersion !== 1 || !value.profiles || typeof value.profiles !== 'object') throw new Error('Invalid profiles file.');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, profiles: {} }; throw error; }
}
/** Resolve a token for the selected server without printing or persisting it. */
export async function resolveCredential(options: { server?: string; store?: CredentialStore; loadStore?: () => Promise<CredentialStore>; allowFileStore?: boolean; fetch?: typeof fetch } = {}): Promise<{ profile: AuthProfile; token: string; refreshToken?: string; authMode?: 'user' | 'token' }> {
  const profiles = await readProfiles();
  const origin = options.server ? normalizeOrigin(options.server) : profiles.current ? profiles.profiles[profiles.current]?.origin : undefined;
  if (!origin) throw new Error('No server selected. Run auth login or provide --server.');
  const key = serverKey(origin), profile = profiles.profiles[key];
  if (!profile) throw new Error('No profile exists for this server. Run auth login first.');
  if (process.env.NOTCHLET_TOKEN?.trim()) return { profile, token: process.env.NOTCHLET_TOKEN, authMode: 'token' };
  let store: CredentialStore;
  if (profile.credentialStore === 'file') {
    if (!options.allowFileStore) throw new Error('This profile uses file credentials; pass --allow-file-token-store to enable it.');
    store = fileCredentialStore();
  } else {
    try { store = options.store ?? await (options.loadStore ?? osCredentialStore)(); }
    catch { if (!options.allowFileStore) throw new Error('OS credential store is unavailable or locked.'); store = fileCredentialStore(); }
  }
  const stored = await store.get(key);
  if (!stored) throw new Error('No credential is available for the selected server. Run `notchlet auth login`.');
  const session = parseUserSession(stored);
  if (!session) return { profile, token: stored, authMode: 'token' };
  let current = session;
  const expiresAt = jwtExpiry(session.accessToken);
  if (expiresAt !== undefined && expiresAt <= Date.now() / 1000 + 60) {
    try {
      current = await refreshUserSession(origin, session, options.fetch ?? fetch);
      await store.set(key, JSON.stringify(current));
    } catch {
      if (expiresAt <= Date.now() / 1000) throw new Error('Notchlet session expired. Run `notchlet auth login` again.');
    }
  }
  return { profile, token: current.accessToken, refreshToken: current.refreshToken, authMode: 'user' };
}
async function writeProfiles(value: Profiles): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(profilesPath(), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(profilesPath(), 0o600);
}
export async function getProfile(server?: string): Promise<AuthProfile | undefined> {
  const profiles = await readProfiles();
  const key = server ? serverKey(normalizeOrigin(server)) : profiles.current;
  return key ? profiles.profiles[key] : undefined;
}

/** Select an existing server profile while preserving all other user-global profiles. */
export async function selectProfile(server: string): Promise<AuthProfile | undefined> {
  const profiles = await readProfiles();
  const key = serverKey(normalizeOrigin(server));
  const profile = profiles.profiles[key];
  if (!profile) return undefined;
  profiles.current = key;
  await writeProfiles(profiles);
  return profile;
}

/** User-confirmed restricted-file adapter, kept separate from profiles.json. */
export function fileCredentialStore(): CredentialStore {
  assertFileFallbackSupported();
  const file = path.join(configDir(), 'credentials.json');
  const read = async (): Promise<Record<string, string>> => {
    try {
      if (process.platform !== 'win32') {
        const { mode } = await (await import('node:fs/promises')).stat(file);
        if ((mode & 0o077) !== 0) throw new Error('Credential file permissions are too broad; restrict it to the current user (0600).');
      }
      return JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  };
  const save = async (values: Record<string, string>) => {
    await mkdir(configDir(), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(file, 0o600);
  };
  return { name: `restricted user file (${file}; permissions 0600; directory 0700)`, async get(k) { return (await read())[k]; }, async set(k, v) { const d = await read(); d[k] = v; await save(d); }, async delete(k) { const d = await read(); delete d[k]; await save(d); } };
}

export function assertFileFallbackSupported(platform = process.platform): void {
  if (platform === 'win32') throw new Error('Restricted-file credential storage is not supported on Windows because file mode bits do not guarantee a private ACL; set NOTCHLET_TOKEN or use a working OS credential store.');
}

/** Lazily load the maintained native OS credential store so non-auth CLI commands don't load native bindings. */
export async function osCredentialStore(loadModule?: () => Promise<any>): Promise<CredentialStore> {
  try {
    const load = loadModule ?? (() => {
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
      return dynamicImport('@napi-rs/keyring');
    });
    const keyring = await load();
    const service = 'notchlet-cli';
    return {
      name: 'operating-system credential store (@napi-rs/keyring)',
      async get(key) { return (await new keyring.Entry(service, key).getPassword()) ?? undefined; },
      async set(key, value) { await new keyring.Entry(service, key).setPassword(value); },
      async delete(key) { await new keyring.Entry(service, key).deletePassword(); },
    };
  } catch {
    // Do not surface native-loader or backend errors; they can contain implementation details.
    throw new Error('OS credential store is unavailable or locked.');
  }
}

export async function readHiddenToken(io: AuthIO = {}, prompt = 'Token (input hidden): '): Promise<string> {
  const input = io.stdin ?? process.stdin, output = io.stdout ?? process.stderr;
  if (!input.isTTY || !output.isTTY || !input.setRawMode) throw new Error('Hidden password/token entry requires a TTY; use NOTCHLET_EMAIL and NOTCHLET_PASSWORD or NOTCHLET_TOKEN for automation.');
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); output.write('\n'); error ? reject(error) : resolve(value); };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error('Token entry cancelled.'));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    input.setRawMode(true); input.resume(); input.on('data', onData);
  });
}

async function readEmail(io: AuthIO = {}): Promise<string> {
  if (io.readLine) return (await io.readLine('Notchlet email: ')).trim();
  const input = io.stdin ?? process.stdin, output = io.stdout ?? process.stderr;
  if (!input.isTTY || !output.isTTY) throw new Error('Interactive login requires a TTY; set NOTCHLET_EMAIL and NOTCHLET_PASSWORD for automation.');
  const readline = createInterface({ input, output });
  try { return (await readline.question('Notchlet email: ')).trim(); }
  finally { readline.close(); }
}

async function loginWithPassword(origin: string, email: string, password: string, fetcher: typeof fetch): Promise<UserSession> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error('Could not reach Notchlet login. Check the server URL and network connection.');
  }
  if (response.status === 401) throw new Error('Email/password authentication failed. Check your credentials.');
  if (response.status === 403) throw new Error('This account cannot sign in yet. Verify the email address or contact your workspace administrator.');
  if (!response.ok) throw new Error(`Notchlet login failed with HTTP ${response.status}.`);
  const result = await response.json() as { accessToken?: unknown; refreshToken?: unknown; user?: { email?: unknown } };
  if (typeof result.accessToken !== 'string' || typeof result.refreshToken !== 'string') throw new Error('Notchlet returned an invalid login response.');
  return { kind: 'notchlet-user-session', accessToken: result.accessToken, refreshToken: result.refreshToken, email: typeof result.user?.email === 'string' ? result.user.email : email };
}

export async function authCommand(action: string, options: { server?: string; allowFileStore?: boolean; json?: boolean; token?: string; email?: string; password?: string; forceUserLogin?: boolean; io?: AuthIO; store?: CredentialStore; loadStore?: () => Promise<CredentialStore>; fetch?: typeof fetch } = {}) {
  const profiles = await readProfiles();
  let origin: string;
  if (options.server) origin = normalizeOrigin(options.server);
  else if (profiles.current && profiles.profiles[profiles.current]) origin = profiles.profiles[profiles.current].origin;
  else throw new Error('No server selected. Provide --server https://host or log in to a server first.');
  const key = serverKey(origin);
  const fallback = () => {
    if (!options.allowFileStore) throw new Error('OS credential store is unavailable or locked. To use the restricted per-user file fallback, explicitly pass --allow-file-token-store.');
    return fileCredentialStore();
  };
  const profile: Profile = { origin, serverIdentity: origin };
  if (action === 'login') {
    const usingEnvironmentToken = !options.forceUserLogin && Boolean(process.env.NOTCHLET_TOKEN?.trim());
    const legacyToken = options.forceUserLogin ? undefined : process.env.NOTCHLET_TOKEN?.trim() || options.token?.trim();
    let credentialValue: string;
    if (legacyToken) {
      profile.authMode = 'token';
      credentialValue = legacyToken;
    } else {
      let email = options.email?.trim() || process.env.NOTCHLET_EMAIL?.trim();
      let password = options.password || process.env.NOTCHLET_PASSWORD;
      if (options.json && (!email || !password)) throw new Error('Interactive email/password login is disabled in JSON mode; set NOTCHLET_EMAIL and NOTCHLET_PASSWORD.');
      if (!email) email = await readEmail(options.io);
      if (!password) password = options.io?.readSecret ? await options.io.readSecret('Notchlet password (input hidden): ') : await readHiddenToken(options.io, 'Notchlet password (input hidden): ');
      if (!email || !password.trim()) throw new Error('Email and password cannot be empty.');
      const session = await loginWithPassword(origin, email, password, options.fetch ?? fetch);
      credentialValue = JSON.stringify(session);
      profile.authMode = 'user';
      profile.email = session.email;
    }
    let selected: CredentialStore | undefined;
    if (!usingEnvironmentToken) {
      try { selected = options.store ?? await (options.loadStore ?? osCredentialStore)(); }
      catch { selected = fallback(); }
      try { await selected.set(key, credentialValue); }
      catch { selected = fallback(); await selected.set(key, credentialValue); }
      profile.credentialStore = selected.name.startsWith('restricted user file') ? 'file' : 'os';
    } else {
      profile.credentialStore = 'environment';
    }
    profiles.profiles[key] = profile; profiles.current = key; await writeProfiles(profiles);
    return { profile, credential: { source: usingEnvironmentToken ? 'environment' : selected!.name, status: 'available' } };
  }
  if (!profiles.profiles[key]) throw new Error('No profile exists for this server. Run auth login first.');
  if (action === 'status') {
    const env = process.env.NOTCHLET_TOKEN;
    let selected: CredentialStore | undefined, saved: string | undefined;
    if (!env) {
      try { selected = profiles.profiles[key].credentialStore === 'file' ? fallback() : options.store ?? await (options.loadStore ?? osCredentialStore)(); saved = await selected.get(key); }
      catch { selected = fallback(); saved = await selected.get(key); }
    }
    return { profile: profiles.profiles[key], current: profiles.current === key, credential: { source: env ? 'environment' : selected?.name ?? 'none', status: env || saved ? 'available' : 'missing' } };
  }
  if (action === 'logout') {
    let selected: CredentialStore;
    try { selected = profiles.profiles[key].credentialStore === 'file' ? fallback() : options.store ?? await (options.loadStore ?? osCredentialStore)(); }
    catch { selected = fallback(); }
    let serverLogout: 'revoked' | 'unavailable' | 'not-user-session' = 'not-user-session';
    const saved = await selected.get(key).catch(() => undefined);
    const session = saved ? parseUserSession(saved) : null;
    if (session) {
      try {
        let current = session;
        const exp = jwtExpiry(session.accessToken);
        if (exp !== undefined && exp <= Date.now() / 1000 + 60) {
          current = await refreshUserSession(origin, session, options.fetch ?? fetch);
          await selected.set(key, JSON.stringify(current));
        }
        const response = await (options.fetch ?? fetch)(`${origin}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${current.accessToken}` } });
        serverLogout = response.ok ? 'revoked' : 'unavailable';
      } catch { serverLogout = 'unavailable'; }
    }
    try { await selected.delete(key); }
    catch { selected = fallback(); await selected.delete(key); }
    delete profiles.profiles[key];
    if (profiles.current === key) profiles.current = Object.keys(profiles.profiles)[0];
    await writeProfiles(profiles);
    return { loggedOut: true, profile: origin, currentProfile: profiles.current ? profiles.profiles[profiles.current] : null, serverLogout, credential: { source: process.env.NOTCHLET_TOKEN ? 'environment' : 'none', status: process.env.NOTCHLET_TOKEN ? 'still configured in environment' : 'removed' } };
  }
  throw new Error('Use auth login, auth status, or auth logout.');
}
