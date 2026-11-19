import { normalizeOrigin, osCredentialStore, type CredentialStore } from './auth.js';
import type { Fetcher } from './integration.js';
import { mergeMcpProjectConfig, removeMcpProjectConfig, inspectMcpProjectConfig, type McpClient } from './mcp-config.js';
import { mcpScopePresetScopes, credentialName, mcpManagement, type McpScopePreset } from './mcp-management.js';
import { mcpCredentialKey, mcpWorkspaceId, readMcpState, writeMcpState, type McpCredentialMetadata, type McpWorkspaceState } from './mcp-state.js';
import { redactMcpText } from './mcp-bridge.js';

export type McpSetupStatus = 'configured' | 'configured-unverified' | 'conflict' | 'declined' | 'skipped';

export type McpSetupResult = {
  status: McpSetupStatus;
  client: McpClient;
  credentialName?: string;
  credentialId?: number;
  scopes?: string[];
  scopePreset?: McpScopePreset;
  configPath?: string;
  toolCount?: number;
  message?: string;
};

export type SetupMcpOptions = {
  root: string;
  server: string;
  client: McpClient;
  store?: CredentialStore;
  loadStore?: () => Promise<CredentialStore>;
  fetch?: Fetcher;
  allowFileStore?: boolean;
  /** Least-privilege `recommended` (default) or the explicit `broader` opt-in. */
  scopePreset?: McpScopePreset;
  confirmEnable: (message: string) => Promise<boolean>;
  verify?: (input: { origin: string; root: string }) => Promise<{ toolCount: number }>;
};

const label: Record<McpClient, string> = { opencode: 'OpenCode', claude: 'Claude Code' };

export function mcpClientLabel(client: McpClient): string { return label[client]; }

async function loadStoreOrThrow(store?: CredentialStore, loadStore?: () => Promise<CredentialStore>): Promise<CredentialStore> {
  try { return store ?? await (loadStore ?? osCredentialStore)(); }
  catch { throw new Error('OS credential store is unavailable or locked. Unlock it and rerun MCP setup; workspace and skill setup are unaffected.'); }
}

/**
 * Configure least-privilege MCP access for one client. Account-level enablement is
 * requested explicitly; the secret only ever goes to the OS credential store.
 */
export async function setupMcpAccess(options: SetupMcpOptions): Promise<McpSetupResult> {
  const origin = normalizeOrigin(options.server);
  const root = options.root;
  const client = options.client;
  const scopePreset = options.scopePreset ?? 'recommended';
  const requestedScopes = mcpScopePresetScopes(scopePreset);
  const state = await readMcpState(root);
  const existing = state.servers[origin];
  const managedEntryHash = existing?.clients[client]?.entryHash;

  const preview = await mergeMcpProjectConfig(root, client, origin, { managedEntryHash });
  if (preview.action === 'conflict') return { status: 'conflict', client, configPath: preview.relativePath, message: preview.reason };

  const api = await mcpManagement(origin, { fetch: options.fetch, store: options.store, loadStore: options.loadStore, allowFileStore: options.allowFileStore });
  const settings = await api.getSettings();
  if (!settings.enabled) {
    const approved = await options.confirmEnable('Notchlet MCP access is disabled for this account. Enabling it is account-wide and allows authenticated MCP clients to reach Notchlet.');
    if (!approved) return { status: 'declined', client, message: 'MCP setup was skipped; the account MCP setting and project configuration were not changed.' };
    await api.setEnabled(true);
  }

  const store = await loadStoreOrThrow(options.store, options.loadStore);
  let credential: McpCredentialMetadata | undefined = existing?.credential;
  let secret = credential ? await store.get(credential.key) : undefined;
  const hasRequestedScopes = Boolean(credential && requestedScopes.length === credential.scopes.length && requestedScopes.every(scope => credential!.scopes.includes(scope)));
  if (!credential || !secret || !hasRequestedScopes) {
    const created = await api.createCredential({ name: credentialName(client, mcpWorkspaceId(root)), scopes: requestedScopes });
    const key = mcpCredentialKey(origin, mcpWorkspaceId(root));
    try { await store.set(key, created.secret); }
    catch (error) {
      await api.revokeCredential(created.id).catch(() => undefined);
      throw new Error(`Could not store the MCP credential in the OS credential store: ${redactMcpText((error as Error).message, created.secret)}`);
    }
    const previous = existing?.credential;
    if (previous?.id && previous.id !== created.id) await api.revokeCredential(previous.id).catch(() => undefined);
    credential = { key, id: created.id, name: created.name, scopes: Array.isArray(created.scopes) && created.scopes.length ? created.scopes : requestedScopes, createdAt: created.createdAt ?? new Date().toISOString() };
  }

  const applied = await mergeMcpProjectConfig(root, client, origin, { managedEntryHash, apply: true });
  if (applied.action === 'conflict' || !applied.entryHash) return { status: 'conflict', client, configPath: applied.relativePath, credentialName: credential.name, credentialId: credential.id, scopes: credential.scopes, scopePreset, message: applied.reason };

  const nextState: McpWorkspaceState = {
    schemaVersion: 1,
    servers: {
      ...state.servers,
      [origin]: {
        credential,
        clients: {
          ...(existing?.clients ?? {}),
          [client]: { relativePath: applied.relativePath, serverName: 'notchlet', entryHash: applied.entryHash, configuredAt: new Date().toISOString() },
        },
      },
    },
  };
  await writeMcpState(root, nextState);

  const base = { client, credentialName: credential.name, credentialId: credential.id, scopes: credential.scopes, scopePreset, configPath: applied.relativePath };
  try {
    const verified = await (options.verify ?? verifyMcpBridge)({ origin, root });
    return { ...base, status: 'configured', toolCount: verified.toolCount };
  } catch (error) {
    return { ...base, status: 'configured-unverified', message: redactMcpText(error instanceof Error ? error.message : 'MCP bridge verification failed.') };
  }
}

/** Verify the merged configuration by starting the real stdio bridge and listing tools. */
export async function verifyMcpBridge(input: { origin: string; root: string; timeoutMs?: number }): Promise<{ toolCount: number; tools: string[] }> {
  if (process.env.NOTCHLET_MCP_VERIFY === '0' || process.env.NOTCHLET_MCP_VERIFY === 'off') return { toolCount: 0, tools: [] };
  const entry = process.argv[1];
  if (!entry) throw new Error('Could not locate the Notchlet CLI entry point to verify the MCP bridge.');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  if (process.env.NOTCHLET_CONFIG_DIR) env.NOTCHLET_CONFIG_DIR = process.env.NOTCHLET_CONFIG_DIR;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'mcp', 'serve', '--server', input.origin, '--workspace', input.root],
    env,
    cwd: input.root,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'notchlet-cli-verify', version: '0.1.0' }, { capabilities: {} });
  let stderr = '';
  const stderrStream = transport.stderr as NodeJS.ReadableStream | null;
  stderrStream?.setEncoding('utf8');
  stderrStream?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MCP bridge verification timed out.')), input.timeoutMs ?? 15_000));
  try {
    const result = await Promise.race([
      (async () => {
        await client.connect(transport);
        const listed = await client.listTools();
        return { toolCount: listed.tools.length, tools: listed.tools.map(tool => tool.name) };
      })(),
      timeout,
    ]);
    return result;
  } catch (error) {
    const detail = redactMcpText(stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? '');
    throw new Error(`${error instanceof Error ? error.message : 'MCP bridge verification failed.'}${detail ? ` (${detail})` : ''}`);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export type McpStatusReport = {
  root: string | null;
  servers: Array<{
    server: string;
    credential?: { name: string; id?: number; scopes: string[]; keyring: 'present' | 'missing' | 'unavailable' };
    account?: { enabled: boolean | null; error?: string };
    clients: Array<{ client: McpClient; state: 'configured' | 'modified' | 'missing' | 'invalid'; path: string; reason?: string }>;
  }>;
};

export async function mcpStatus(input: { root: string | null; server?: string; client?: McpClient; store?: CredentialStore; loadStore?: () => Promise<CredentialStore>; fetch?: Fetcher; allowFileStore?: boolean }): Promise<McpStatusReport> {
  const report: McpStatusReport = { root: input.root, servers: [] };
  if (!input.root) return report;
  const state = await readMcpState(input.root);
  const origins = input.server ? [normalizeOrigin(input.server)] : Object.keys(state.servers);
  let store: CredentialStore | undefined;
  let storeError: string | undefined;
  try { store = input.store ?? await (input.loadStore ?? osCredentialStore)(); }
  catch { storeError = 'OS credential store is unavailable or locked.'; }
  for (const origin of origins) {
    const entry = state.servers[origin];
    let account: { enabled: boolean | null; error?: string } | undefined;
    try {
      const api = await mcpManagement(origin, { fetch: input.fetch, store: input.store, loadStore: input.loadStore, allowFileStore: input.allowFileStore });
      account = { enabled: (await api.getSettings()).enabled };
    } catch (error) {
      account = { enabled: null, error: redactMcpText(error instanceof Error ? error.message : 'Account MCP status is unavailable.') };
    }
    const clients: McpStatusReport['servers'][number]['clients'] = [];
    const names = new Set<McpClient>();
    for (const name of Object.keys(entry?.clients ?? {}) as McpClient[]) names.add(name);
    if (input.client) names.add(input.client);
    for (const client of names) {
      const inspected = await inspectMcpProjectConfig(input.root, client, origin);
      const clientState = inspected.action === 'unchanged' ? 'configured' : inspected.action === 'conflict' ? (inspected.present ? 'modified' : 'invalid') : 'missing';
      clients.push({ client, state: clientState, path: inspected.relativePath, ...(inspected.reason ? { reason: inspected.reason } : {}) });
    }
    let keyring: 'present' | 'missing' | 'unavailable' = storeError ? 'unavailable' : 'missing';
    if (store && entry?.credential?.key && await store.get(entry.credential.key).catch(() => undefined)) keyring = 'present';
    report.servers.push({
      server: origin,
      ...(entry ? { credential: { name: entry.credential.name, scopes: entry.credential.scopes, ...(entry.credential.id ? { id: entry.credential.id } : {}), keyring } } : {}),
      ...(account ? { account } : {}),
      clients,
    });
  }
  return report;
}

export type DisconnectResult = {
  removed: Array<{ client: McpClient; path: string; action: string; reason?: string }>;
  credential?: { id?: number; name: string; revoked: boolean; keyring: 'removed' | 'kept' | 'missing'; message?: string };
  message?: string;
};

export async function mcpDisconnect(input: {
  root: string;
  server?: string;
  client?: McpClient;
  revoke?: boolean;
  yes?: boolean;
  confirm: (message: string) => Promise<boolean>;
  store?: CredentialStore;
  loadStore?: () => Promise<CredentialStore>;
  fetch?: Fetcher;
  allowFileStore?: boolean;
}): Promise<DisconnectResult> {
  const state = await readMcpState(input.root);
  const origins = input.server ? [normalizeOrigin(input.server)] : Object.keys(state.servers);
  if (!origins.length) return { removed: [], message: 'No MCP configuration is recorded for this workspace.' };
  const targets: Array<{ origin: string; client: McpClient }> = [];
  for (const origin of origins) {
    const configured = Object.keys(state.servers[origin]?.clients ?? {}) as McpClient[];
    const clients = input.client ? [input.client] : configured;
    for (const client of clients) targets.push({ origin, client });
  }
  if (!targets.length && !origins.some(origin => state.servers[origin])) return { removed: [], message: 'No MCP client configuration is recorded for this workspace.' };

  if (targets.length && !input.yes) {
    const paths = targets.map(target => inspectMcpPathLabel(target.client, state, target.origin)).join(', ');
    const confirmed = await input.confirm(`Remove the Notchlet MCP entry for ${paths}? Other configuration is preserved.`);
    if (!confirmed) return { removed: [], message: 'Cancelled; no files were changed.' };
  }

  const removed: DisconnectResult['removed'] = [];
  const nextState: McpWorkspaceState = { schemaVersion: 1, servers: { ...state.servers } };
  for (const target of targets) {
    const result = await removeMcpProjectConfig(input.root, target.client, { apply: true, allowModified: true });
    removed.push({ client: target.client, path: result.relativePath, action: result.action, ...(result.reason ? { reason: result.reason } : {}) });
    const serverState = nextState.servers[target.origin];
    if (serverState?.clients?.[target.client]) {
      const clients = { ...serverState.clients };
      delete clients[target.client];
      nextState.servers[target.origin] = { ...serverState, clients };
    }
  }

  let outcome: DisconnectResult['credential'];
  const store = await loadStoreOrThrow(input.store, input.loadStore).catch(() => undefined);
  for (const origin of origins) {
    const entry = nextState.servers[origin];
    if (!entry || Object.keys(entry.clients ?? {}).length) continue;
    if (!input.revoke) {
      outcome = { name: entry.credential.name, ...(entry.credential.id ? { id: entry.credential.id } : {}), revoked: false, keyring: 'kept' };
      continue;
    }
    const shouldRevoke = input.yes || await input.confirm(`Revoke MCP credential "${entry.credential.name}" for ${origin}? This affects every client using it.`);
    let revoked = false;
    let message: string | undefined;
    if (shouldRevoke) {
      if (entry.credential.id) {
        try {
          const api = await mcpManagement(origin, { fetch: input.fetch, store: input.store, loadStore: input.loadStore, allowFileStore: input.allowFileStore });
          await api.revokeCredential(entry.credential.id);
          revoked = true;
        } catch (error) {
          message = redactMcpText(error instanceof Error ? error.message : 'Credential revocation failed.');
        }
      } else message = 'No remote credential ID is recorded; remove it from the Notchlet account manually.';
    }
    const keyring = store ? await store.delete(entry.credential.key).then(() => 'removed' as const).catch(() => 'kept' as const) : 'kept';
    if (revoked) delete nextState.servers[origin];
    outcome = { name: entry.credential.name, ...(entry.credential.id ? { id: entry.credential.id } : {}), revoked, keyring, ...(message ? { message } : {}) };
  }

  await writeMcpState(input.root, nextState);
  return { removed, ...(outcome ? { credential: outcome } : {}) };
}

function inspectMcpPathLabel(client: McpClient, state: McpWorkspaceState, origin: string): string {
  return state.servers[origin]?.clients[client]?.relativePath ?? (client === 'claude' ? '.mcp.json' : 'opencode.json');
}

export type RevokeResult = { origin: string; credentialName?: string; credentialId?: number; revoked: boolean; keyring: 'removed' | 'missing' | 'kept'; message?: string };

export async function mcpRevoke(input: {
  root: string | null;
  server?: string;
  credentialId?: number;
  yes?: boolean;
  confirm: (message: string) => Promise<boolean>;
  store?: CredentialStore;
  loadStore?: () => Promise<CredentialStore>;
  fetch?: Fetcher;
  allowFileStore?: boolean;
}): Promise<RevokeResult> {
  const state = input.root ? await readMcpState(input.root) : { schemaVersion: 1 as const, servers: {} };
  const origin = input.server ? normalizeOrigin(input.server) : Object.keys(state.servers)[0];
  if (!origin) throw new Error('No MCP configuration is recorded. Pass --server and --credential-id, or run MCP setup first.');
  const entry = state.servers[origin];
  const credentialId = input.credentialId ?? entry?.credential.id;
  if (!credentialId) throw new Error('No generated MCP credential ID is recorded. Pass --credential-id to revoke one directly.');
  if (!input.yes) {
    const confirmed = await input.confirm(`Revoke MCP credential ${credentialId}${entry?.credential.name ? ` (${entry.credential.name})` : ''} for ${origin}? This is account-wide for every client using it.`);
    if (!confirmed) return { origin, credentialId, revoked: false, keyring: 'kept', message: 'Cancelled; no changes were made.' };
  }
  const api = await mcpManagement(origin, { fetch: input.fetch, store: input.store, loadStore: input.loadStore, allowFileStore: input.allowFileStore });
  let revoked = true;
  try { await api.revokeCredential(credentialId); }
  catch (error) {
    if (/HTTP 404/.test((error as Error).message)) revoked = false;
    else throw error;
  }
  let keyring: RevokeResult['keyring'] = 'missing';
  if (entry?.credential.key) {
    const store = await loadStoreOrThrow(input.store, input.loadStore).catch(() => undefined);
    keyring = store ? await store.delete(entry.credential.key).then(() => 'removed' as const).catch(() => 'kept' as const) : 'kept';
  }
  if (input.root && entry) {
    const servers = { ...state.servers };
    delete servers[origin];
    await writeMcpState(input.root, { schemaVersion: 1, servers });
  }
  return { origin, ...(entry?.credential.name ? { credentialName: entry.credential.name } : {}), credentialId, revoked, keyring, ...(revoked ? {} : { message: 'The credential was already revoked or not found; local secrets were removed.' }) };
}
