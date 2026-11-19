import { createInterface } from 'node:readline/promises';
import { initWorkspace } from '@notchlet/core';
import { authCommand, getProfile, readHiddenToken, resolveCredential, type AuthIO, type CredentialStore } from './auth.js';
import { bindWorkspace, platformApi, setWorkspaceSyncMode, type Fetcher } from './integration.js';
import { installClientGuidance, type GuidanceClient } from './guidance-install.js';
import { setupMcpAccess, type McpSetupResult } from './mcp-onboarding.js';
import { MCP_SCOPE_PRESET_LABELS, type McpScopePreset } from './mcp-management.js';
import type { McpClient } from './mcp-config.js';

export interface SetupIO extends AuthIO {
  readLine: (prompt: string) => Promise<string>;
  write: (text: string) => void;
}

type SetupResult = {
  root: string;
  mode: 'local' | 'connected';
  initialized: true;
  accountConnected?: boolean;
  organizationId?: number;
  productId?: number;
  message?: string;
  binding?: any;
  syncMode?: 'auto' | 'manual';
  guidance?: Awaited<ReturnType<typeof installClientGuidance>>;
  mcp?: McpSetupResult;
};

function terminalSetupIO(): SetupIO {
  const input = process.stdin;
  const output = process.stderr;
  const readLine = async (prompt: string) => {
    if (!input.isTTY || !output.isTTY) throw new Error('Interactive setup requires a terminal. Use `notchlet init --local` or run `notchlet init --interactive` in a TTY.');
    const rl = createInterface({ input, output });
    try { return await rl.question(prompt); }
    finally { rl.close(); }
  };
  return {
    stdin: input,
    stdout: output,
    readLine,
    readSecret: (prompt) => readHiddenToken({ stdin: input, stdout: output }, prompt),
    write: (text) => output.write(`${text}\n`),
  };
}

async function choose<T>(io: SetupIO, title: string, values: T[], label: (value: T) => string, defaultIndex = 0): Promise<T> {
  if (values.length === 0) throw new Error(`No ${title.toLowerCase()} are available for this account.`);
  io.write(title);
  values.forEach((value, index) => io.write(`  ${index + 1}) ${label(value)}${index === defaultIndex ? ' (default)' : ''}`));
  while (true) {
    const answer = (await io.readLine(`Choose 1-${values.length}${defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : ''}: `)).trim();
    if (!answer && defaultIndex >= 0) return values[defaultIndex];
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < values.length) return values[index];
    io.write(`Enter a number from 1 to ${values.length}.`);
  }
}

async function askYesNo(io: SetupIO, text: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n]' : ' [y/N]';
  while (true) {
    const answer = (await io.readLine(`${text}${suffix}: `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    io.write('Enter y or n.');
  }
}

export async function interactiveInit(root: string, options: { io?: SetupIO; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore>; verifyMcp?: (input: { origin: string; root: string }) => Promise<{ toolCount: number }> } = {}): Promise<SetupResult> {
  const io = options.io ?? terminalSetupIO();
  await initWorkspace(root);
  io.write('Set up this checkout for Notchlet:');
  const mode = await choose(io, 'Choose a mode:', ['local', 'connected'] as const, (value) => value === 'local' ? 'Local-only (offline; no account login)' : 'Connect to a Notchlet account', 0);
  const client = await choose(io, 'Set up coding-agent skills:', ['opencode', 'claude', 'skip'] as const, (value) => value === 'opencode' ? 'Install for OpenCode' : value === 'claude' ? 'Install for Claude Code' : 'Skip for now', 0);
  let guidance: Awaited<ReturnType<typeof installClientGuidance>> | undefined;
  if (client !== 'skip') {
    guidance = await installClientGuidance(root, client as GuidanceClient, { apply: true });
    const applied = guidance.results.filter(result => result.applied).length;
    const conflicts = guidance.results.filter(result => result.action === 'conflict').length;
    io.write(`Agent skills: ${applied} installed or updated${conflicts ? `; ${conflicts} conflict(s) preserved` : ''}.`);
  }
  let configureMcp = false;
  let scopePreset: McpScopePreset | undefined;
  if (mode === 'connected' && client !== 'skip') {
    const clientName = client === 'opencode' ? 'OpenCode' : 'Claude Code';
    configureMcp = (await choose(io, `Configure Notchlet MCP for ${clientName}?`, ['yes', 'skip'] as const, (value) => value === 'yes' ? 'Yes — configure project MCP access securely' : 'Skip MCP setup', 0)) === 'yes';
    if (configureMcp) {
      io.write('Broader scopes let the agent write documents, tickets, generation runs, and synced issues in addition to workspace, backlog, and change data. Least privilege stays the default.');
      scopePreset = await choose(io, 'MCP credential scopes:', ['recommended', 'broader'] as const, (value) => MCP_SCOPE_PRESET_LABELS[value], 0);
    }
  }
  if (mode === 'local') return { root, mode: 'local', initialized: true, ...(guidance ? { guidance } : {}) };

  const currentProfile = await getProfile().catch(() => undefined);
  const suggestedServer = process.env.NOTCHLET_SERVER ?? currentProfile?.origin ?? '';
  const serverAnswer = (await io.readLine(`Notchlet server HTTPS origin${suggestedServer ? ` [${suggestedServer}]` : ''}: `)).trim();
  const server = serverAnswer || suggestedServer;
  if (!server) throw new Error('A Notchlet server URL is required to connect. The local workspace is initialized and remains usable offline.');

  if (process.env.NOTCHLET_TOKEN?.trim()) {
    throw new Error('Connected interactive setup needs a Notchlet account session. Unset NOTCHLET_TOKEN (a scoped API credential) and rerun `notchlet init`, or use `--local`.');
  }
  let profile = await getProfile(server).catch(() => undefined);
  if (!profile || profile.authMode !== 'user') {
    await authCommand('login', { server, fetch: options.fetch, io, store: options.store, loadStore: options.loadStore, forceUserLogin: true });
    profile = await getProfile(server);
  } else {
    try { await resolveCredential({ server, fetch: options.fetch, store: options.store, loadStore: options.loadStore }); }
    catch {
      await authCommand('login', { server, fetch: options.fetch, io, store: options.store, loadStore: options.loadStore, forceUserLogin: true });
      profile = await getProfile(server);
    }
  }

  let mcp: McpSetupResult | undefined;
  if (configureMcp) {
    try {
      mcp = await setupMcpAccess({
        root,
        server,
        client: client as McpClient,
        fetch: options.fetch,
        store: options.store,
        loadStore: options.loadStore,
        verify: options.verifyMcp,
        scopePreset,
        confirmEnable: (message) => askYesNo(io, message, false),
      });
      if (mcp.status === 'configured') io.write(`MCP: configured for ${mcp.client === 'opencode' ? 'OpenCode' : 'Claude Code'}${typeof mcp.toolCount === 'number' && mcp.toolCount > 0 ? ` (${mcp.toolCount} tools verified)` : ''}.`);
      else if (mcp.status === 'configured-unverified') io.write(`MCP: configuration written, but live verification failed. ${mcp.message ?? ''}`.trim());
      else io.write(`MCP: ${mcp.message ?? mcp.status}`);
    } catch (error) {
      mcp = { status: 'skipped', client: client as McpClient, message: error instanceof Error ? error.message : 'MCP setup failed.' };
      io.write(`MCP setup skipped: ${mcp.message}`);
    }
  }

  const api = await platformApi(server, { fetch: options.fetch, store: options.store, loadStore: options.loadStore });
  const organizations = await api.get('/organizations/mine') as Array<{ id: number; name: string; slug?: string }>;
  if (!organizations.length) return { root, mode: 'local', initialized: true, accountConnected: true, message: 'No organizations are available to this account yet; the checkout remains local-only.', ...(mcp ? { mcp } : {}) };
  const organization = await choose(io, 'Organizations:', organizations, (item) => `${item.name} (#${item.id})`);
  const products = await api.get(`/products?organizationId=${organization.id}`) as Array<{ id: number; name: string; team?: { name?: string } }>;
  if (!products.length) return { root, mode: 'local', initialized: true, accountConnected: true, organizationId: organization.id, message: 'This organization has no products yet; the checkout remains local-only.', ...(mcp ? { mcp } : {}) };
  const product = await choose(io, 'Products:', products, (item) => `${item.name}${item.team?.name ? ` · ${item.team.name}` : ''} (#${item.id})`);
  const repositoryResponse = await api.get(`/git/config?productId=${product.id}`);
  const repositories = Array.isArray(repositoryResponse) ? repositoryResponse : repositoryResponse ? [repositoryResponse] : [];
  if (!repositories.length) return { root, mode: 'local', initialized: true, accountConnected: true, productId: product.id, message: 'No repositories are connected to this product. Local work remains available; connect a repository before binding for remote sync.', ...(mcp ? { mcp } : {}) };
  const repository = await choose(io, 'Repositories:', repositories, (item: any) => `${item.repoLabel ?? `${item.repoOwner ?? ''}/${item.repoName ?? ''}`} · ${item.provider ?? 'Git'} (#${item.id})`);
  const syncMode = await choose(io, 'Sync preference:', ['auto', 'manual'] as const, (value) => value === 'auto' ? 'Automatic on CLI use when online (conflicts remain explicit)' : 'Manual only; sync only when requested', 0);
  const binding = await bindWorkspace(root, { server, productId: product.id, repositoryId: repository.id, fetch: options.fetch, store: options.store, loadStore: options.loadStore });
  await setWorkspaceSyncMode(root, syncMode);
  io.write(`Connected to ${organization.name} / ${product.name} / ${repository.repoLabel ?? repository.repoName}.`);
  io.write(`Sync mode: ${syncMode}.`);
  return { root, mode: 'connected', initialized: true, binding, syncMode, ...(guidance ? { guidance } : {}), ...(mcp ? { mcp } : {}) };
}
