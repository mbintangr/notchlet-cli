#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { appendEvidence, CORE_VERSION, closeChange, evaluateState, findWorkspace, initWorkspace, instructions, listChanges, persistConversion, previewCapabilityClose, readChange, readiness, scaffold, transitionTask, WorkflowError, type EvidenceWriteInput, type TaskStatus, type WorkflowAction, type CliJsonEnvelope } from '@notchlet/core';
import { section, kv, bullet, ok, err, warn, table, box, divider } from './cli-format.js';
import { isTty, prompt, secret, confirm, requiredString } from './cli-prompt.js';

const args = process.argv.slice(2);
const profiling = process.env.NOTCHLET_PROFILE === '1';
const profileTimings: Record<string, number> = {};
const profileNow = () => Number(process.hrtime.bigint()) / 1e6;
function profileSync<T>(name: string, operation: () => T): T {
  if (!profiling) return operation();
  const start = profileNow();
  try { return operation(); }
  finally { profileTimings[name] = (profileTimings[name] ?? 0) + profileNow() - start; }
}
async function profileAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!profiling) return operation();
  const start = profileNow();
  try { return await operation(); }
  finally { profileTimings[name] = (profileTimings[name] ?? 0) + profileNow() - start; }
}
const json = args.includes('--json');
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (['--workspace', '--root', '--schema', '--action', '--server', '--client', '--credential-id', '--product-id', '--product', '--repository-id', '--repository', '--endpoint', '--item-id', '--change', '--name', '--snapshot-revision', '--summary', '--backlog-status', '--baseline-revision', '--revision', '--file'].includes(args[i])) { i++; continue; }
  if (!args[i].startsWith('--')) positional.push(args[i]);
}
const rootOption = args.find(arg => arg.startsWith('--workspace=') || arg.startsWith('--root='));
const explicitRoot = rootOption?.slice(rootOption.indexOf('=') + 1) ?? (args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : args.includes('--root') ? args[args.indexOf('--root') + 1] : undefined);
const workspace = () => findWorkspace(process.cwd(), explicitRoot);
const DEFAULT_SERVER = 'https://pg-api.mbintangr.com';
const optionValue = (name: string): string | undefined => { const eq = args.find(arg => arg.startsWith(`${name}=`)); return eq ? eq.slice(name.length + 1) : args.includes(name) ? args[args.indexOf(name) + 1] : undefined; };
const serverOption = (): string => optionValue('--server') ?? DEFAULT_SERVER;
async function pickNamedValue<T>(input: string | undefined, items: T[], options: { kind: string; promptText: string; label: (item: T) => string; keys: (item: T) => string[] }): Promise<T | undefined> {
  const query = input?.trim().toLocaleLowerCase();
  let matches = items;
  if (query) {
    const exact = items.filter(item => options.keys(item).some(key => key.toLocaleLowerCase() === query));
    matches = exact.length ? exact : items.filter(item => options.keys(item).some(key => key.toLocaleLowerCase().includes(query)));
    if (!matches.length) {
      if (!isTty()) return undefined;
      matches = items;
    }
    if (matches.length === 1) return matches[0];
  } else if (!isTty()) return undefined;
  if (!isTty()) throw new Error(`${options.kind} name is ambiguous: ${matches.slice(0, 10).map(options.label).join('; ')}. Use a more specific name or ID.`);
  const choices = matches.slice(0, 20);
  process.stderr.write(`${options.kind} choices:\n${choices.map((item, index) => `  ${index + 1}) ${options.label(item)}`).join('\n')}\n`);
  while (true) {
    const answer = await prompt(`${options.promptText} (1-${choices.length}): `);
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index];
    process.stderr.write(`Enter a number from 1 to ${choices.length}.\n`);
  }
}
async function resolveChangeRef(root: string, input: string): Promise<string> {
  const selected = await pickNamedValue(input, await listChanges(root), {
    kind: 'Change', promptText: 'Select change', label: item => `${item.name} (${item.id})`, keys: item => [item.id, item.name],
  });
  if (!selected) throw new Error(`No change matched "${input}". Use a change name or ID from \`notchlet change list\`.`);
  return selected.id;
}
const command = args.includes('--version') ? 'version' : positional[0] ?? 'help';
const envelope = (ok: boolean, data: unknown = null, error: CliJsonEnvelope['error'] = null, warnings: unknown[] = []): CliJsonEnvelope => ({ protocolVersion: 1, command, ok, data, error, warnings });
function print(data: unknown, human?: string): void { console.log(json ? JSON.stringify(envelope(true, data)) : human ?? JSON.stringify(data, null, 2)); }
function showCommandHelp(name: string, text: string): void {
  if (json) { print({ usage: text }, text); }
  else { console.log(text); }
  process.exitCode = 0;
  throw new Error('handled');
}
function fail(code: string, message: string, recovery: string, exitCode: number): never {
  if (json) console.log(JSON.stringify(envelope(false, null, { code, message, recovery }, [])));
  else console.error(`${err(`${code}: ${message}`)}\nRecovery: ${recovery}`);
  process.exitCode = exitCode;
  throw new Error('handled');
}
const usage = `Usage: notchlet <command> [options]

${section('Setup')}
  init [path] [--local|--interactive]   Initialize a Notchlet workspace (local-only by default)

${section('Auth')}
  auth login [--server <url>] [--allow-file-token-store]   Log in to a Notchlet server
  auth status                                               Show current auth profile
  auth logout [--server <url>]                              Log out of a server
  profile use --server <url>                                Select the current server profile

${section('Workspace')}
  workspace bind --server <url> [--product <name>] [--repository <name>] [--rebind]   Bind checkout to a product/repository
  workspace info                                                        Show workspace binding and config
  doctor                                                                Diagnose workspace, binding, and server connectivity

${section('Sync')}
  sync mode auto|manual                                     Set automatic sync preference
  sync status|push|pull|resolve --change <name|id> [--yes] [--keep-local]   Sync a change with the remote

${section('Changes')}
  change new <name> [--quick]                               Create a new change
  change list                                               List all changes
  change show <name|id>                                     Show change details and readiness
  change convert <name|id> --schema quick|standard           Convert a change schema
  change close <name|id> --preview | --baseline-revision <n> [--yes]   Close and archive a change

${section('Tasks')}
  task start <task-name|id> --change <name|id> --revision <n>  Start a task
  task complete <task-name|id> --change <name|id> --revision <n> Complete a task
  task update <change-name|id> <task-name|id> <status> <revision> Update a task status

${section('Other')}
  backlog import <item-key|title|id> [--product-id <id>]     Import a backlog item as a change
  checkpoint --change <name|id> --name <name> [--summary <text>] [--backlog-status TODO|IN_PROGRESS|IN_REVIEW|DONE]   Create a remote checkpoint
  evidence record --change <name|id> --file <json-path>     Record evidence for a change
  instructions <change-name|id> [--action plan|revise|implement|verify|resume] Get workflow instructions for a change
  client init|update opencode|claude [--apply]              Install client guidance (skills)

${section('MCP')}
  mcp serve --server <url> [--client opencode|claude]       Run the local stdio MCP bridge
  mcp status [--server <url>] [--client opencode|claude]    Show MCP setup, credential, and config state
  mcp disconnect [--client opencode|claude] [--revoke] [--yes]   Remove this project's MCP entry
  mcp revoke [--server <url>] [--credential-id <id>] [--yes]     Revoke the stored MCP credential

${section('Global options')}
  --json           Machine-readable JSON output
  --workspace <root> / --root <root>   Set workspace root
  --server <url>   Notchlet server (default: ${DEFAULT_SERVER})
  --version        Show version
`;

function deriveStatus(state: ReturnType<typeof evaluateState>): string {
  return `Tasks: ${state.execution.completed}/${state.execution.total} completed${state.execution.inProgress ? `, ${state.execution.inProgress} in progress` : ''}. Planning: ${state.planning.status}; verification: ${state.verification.status}; local closure: ${state.localClosure.status}; remote delivery: ${state.remoteDelivery.status}. Completion does not imply verification or delivery.`;
}

async function syncIfAutomatic(root: string, changeId: string) {
  let mode: string;
  try {
    const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    mode = workspace.preferences?.syncMode === 'auto' ? 'auto' : 'manual';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') mode = 'manual';
    else throw error;
  }
  if (mode !== 'auto') return null;
  const { autoSyncChange } = await import('./integration.js');
  return autoSyncChange(root, changeId, { server: optionValue('--server'), endpoint: optionValue('--endpoint') });
}

function printWithSync(result: unknown, automaticSync: unknown | null, human?: string) {
  const base = json ? JSON.stringify(envelope(true, result)) : human ?? JSON.stringify(result, null, 2);
  if (!automaticSync) { console.log(base); return; }
  const syncState = (automaticSync as any)?.state ?? 'pending';
  if (json) { console.log(JSON.stringify(envelope(true, { result, automaticSync }))); }
  else { console.log(`${base}\nAutomatic sync: ${syncState}`); }
}

const EVIDENCE_INPUT_LIMIT_BYTES = 32 * 1024;
function parseEvidenceWriteInput(value: unknown): EvidenceWriteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Evidence input must be a JSON object.');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['kind', 'outcome', 'summary', 'command', 'requirementIds', 'taskIds', 'checkIds', 'provenance']);
  const unsupported = Object.keys(record).find(key => !allowed.has(key));
  if (unsupported) throw new Error(`Unsupported evidence field: ${unsupported}.`);
  if (!['check', 'note', 'artifact'].includes(String(record.kind))) throw new Error('Evidence kind must be check, note, or artifact.');
  if (!['passed', 'failed', 'informational'].includes(String(record.outcome))) throw new Error('Evidence outcome must be passed, failed, or informational.');
  if (typeof record.summary !== 'string' || !record.summary.trim()) throw new Error('Evidence summary must be a non-empty string.');
  if (!Array.isArray(record.requirementIds) || !record.requirementIds.every(item => typeof item === 'string')) throw new Error('Evidence requirementIds must be an array of strings.');
  if (!Array.isArray(record.taskIds) || !record.taskIds.every(item => typeof item === 'string')) throw new Error('Evidence taskIds must be an array of strings.');
  if (record.checkIds !== undefined && (!Array.isArray(record.checkIds) || !record.checkIds.every(item => typeof item === 'string'))) throw new Error('Evidence checkIds must be an array of strings.');
  if (record.command !== undefined && typeof record.command !== 'string') throw new Error('Evidence command must be a descriptive string.');
  if (record.provenance !== 'recorded' && record.provenance !== 'imported') throw new Error('Evidence provenance must be recorded or imported.');
  return record as unknown as EvidenceWriteInput;
}

async function artifactContents(root: string, id: string, change: Awaited<ReturnType<typeof readChange>>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const relative of Object.values(change.artifacts)) {
    try { result[relative] = await readFile(path.join(root, '.notchlet', 'changes', id, relative), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}

async function requireWorkspace(what: string): Promise<string> {
  const root = await workspace();
  if (!root) fail('setup_required', `No initialized Notchlet workspace was found.`, `Run \`notchlet init\` before \`${what}\`.`, 2);
  return root;
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

async function main() {
  try {
    // Command-specific --help is handled inside each command block below.
    // Only show general help when there's no command or command is literally 'help'.
    if ((command === 'help' || positional.length === 0) && (args.includes('--help') || args.includes('-h') || command === 'help')) {
      print({ usage }, usage);
    }
    else if (args.includes('--version') || command === 'version') {
      const version = await packageVersion();
      print({ version, coreVersion: CORE_VERSION }, `notchlet ${version} · @notchlet/core ${CORE_VERSION}`);
    }
    else if (command === 'auth') {
      const action = positional[1];
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('auth', `notchlet auth <action> [options]

  login [--server <url>] [--allow-file-token-store]   Log in to a Notchlet server
  status                                               Show current auth profile
  logout [--server <url>]                              Log out of a server

Options:
  --server <url>   Notchlet server (default: ${DEFAULT_SERVER})
  --allow-file-token-store   Allow restricted file credential storage (Windows requires this or NOTCHLET_TOKEN)
  --json           Machine-readable JSON output`);
      }
      if (!['login', 'status', 'logout'].includes(action ?? '')) fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
      const { authCommand } = await import('./auth.js');
      const result = await authCommand(action, { server: action === 'login' ? serverOption() : optionValue('--server'), allowFileStore: args.includes('--allow-file-token-store'), json });
      if (json) { print(result); }
      else if (action === 'login') {
        const p = (result as any).profile;
        console.log(box([
          section('Logged in'),
          kv('Server', p.origin),
          kv('Email', p.email ?? '(not provided)'),
          kv('Auth mode', p.authMode ?? '(unknown)'),
          kv('Credential store', (result as any).credential.source),
          kv('Credential status', (result as any).credential.status),
        ]));
      } else if (action === 'status') {
        const p = (result as any).profile;
      console.log(box([
        section('Auth status'),
        kv('Server', p.origin),
        kv('Email', p.email ?? '(not provided)'),
        kv('Current profile', (result as any).current ? 'yes' : 'no'),
        kv('Auth mode', p.authMode ?? '(unknown)'),
        kv('Credential source', (result as any).credential.source),
        kv('Credential status', (result as any).credential.status),
      ]));
      } else {
        console.log(box([
          section('Logged out'),
          kv('Server', (result as any).profile),
          kv('Server logout', (result as any).serverLogout),
          kv('Credential status', (result as any).credential.status),
        ]));
      }
    } else if (command === 'profile' && positional[1] === 'use') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('profile use', `notchlet profile use --server <url>

  Select the current server profile.

Options:
  --server <url>   Notchlet server (default: ${DEFAULT_SERVER})
  --json           Machine-readable JSON output`);
      }
      const origin = await requiredString(serverOption(), `Notchlet server HTTPS origin [${DEFAULT_SERVER}]: `) ?? DEFAULT_SERVER;
      const { selectProfile } = await import('./auth.js');
      const profile = await selectProfile(origin);
      if (!profile) fail('profile_not_found', `No profile exists for ${origin}.`, `Run \`notchlet auth login --server ${origin}\` first.`, 2);
      if (json) { print({ profile, current: true }); }
      else {
        console.log(box([
          section('Profile selected'),
          kv('Server', profile.origin),
          kv('Auth mode', profile.authMode ?? '(unknown)'),
          kv('Current', 'yes'),
        ]));
      }
    }
    else if (command === 'workspace' && ['bind', 'rebind'].includes(positional[1] ?? '')) {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('workspace bind', `notchlet workspace bind --server <url> [--product <name|id>] [--repository <name|owner/repo|id>] [--rebind]

  Bind a Git checkout to a Notchlet product and repository.

Options:
  --server <url>             Notchlet server (default: ${DEFAULT_SERVER})
  --product <name|id>        Product name or ID (defaults to an interactive picker)
  --repository <name|owner/repo|id>  Repository name or ID (defaults to an interactive picker)
  --product-id <id>          Product ID (numeric, retained for scripts)
  --repository-id <id>       Repository ID (numeric, retained for scripts)
  --rebind                   Confirm rebinding if the workspace is already bound
  --endpoint <url>           Override MCP endpoint
  --allow-file-token-store   Allow restricted file credential storage
  --json                     Machine-readable JSON output`);
      }
      const root = await requireWorkspace('workspace bind');
      const server = await requiredString(serverOption(), `Notchlet server HTTPS origin [${DEFAULT_SERVER}]: `) ?? DEFAULT_SERVER;
      const productQuery = optionValue('--product') ?? optionValue('--product-id');
      const repositoryQuery = optionValue('--repository') ?? optionValue('--repository-id');
      let product: any;
      let repository: any;
      if (/^\d+$/.test(productQuery ?? '') && /^\d+$/.test(repositoryQuery ?? '')) {
        product = { id: Number(productQuery) };
        repository = { id: Number(repositoryQuery) };
      } else {
        const { platformApi } = await import('./integration.js');
        const api = await platformApi(server, { allowFileStore: args.includes('--allow-file-token-store') });
        const organizations = await api.get('/organizations/mine') as Array<{ id: number; name: string }>;
        const allProducts: any[] = [];
        for (const organization of organizations) {
          const products = await api.get(`/products?organizationId=${organization.id}`) as any[];
          allProducts.push(...products.map(item => ({ ...item, organizationName: organization.name })));
        }
        product = await pickNamedValue(productQuery, allProducts, {
          kind: 'Product', promptText: 'Select product',
          label: item => `${item.name} · ${item.organizationName} (#${item.id})`,
          keys: item => [item.name, item.organizationName, `${item.name} ${item.organizationName}`, String(item.id)],
        });
        if (!product) fail('product_not_found', `No product matched ${productQuery ? `"${productQuery}"` : 'the selection'}.`, 'Choose a product available to this account or provide --product-id.', 2);
        const repositories = await api.get(`/git/config?productId=${product.id}`);
        const repositoryList = Array.isArray(repositories) ? repositories : repositories ? [repositories] : [];
        repository = await pickNamedValue(repositoryQuery, repositoryList, {
          kind: 'Repository', promptText: 'Select repository',
          label: item => `${item.repoLabel ?? `${item.repoOwner ?? ''}/${item.repoName ?? ''}`} · ${item.provider ?? 'Git'} (#${item.id})`,
          keys: item => [item.repoLabel, `${item.repoOwner ?? ''}/${item.repoName ?? ''}`, item.repoName, String(item.id)].filter(Boolean),
        });
        if (!repository) fail('repository_not_found', `No repository matched ${repositoryQuery ? `"${repositoryQuery}"` : 'the selection'}.`, 'Choose a repository connected to this product or provide --repository-id.', 2);
      }
      if (!Number.isSafeInteger(Number(product.id)) || !Number.isSafeInteger(Number(repository.id))) fail('usage_error', usage, 'Provide a product and repository available to your account.', 64);
      const { bindWorkspace } = await import('./integration.js');
      const result = await bindWorkspace(root, { server, productId: Number(product.id), repositoryId: Number(repository.id), endpoint: optionValue('--endpoint'), rebind: positional[1] === 'rebind' || args.includes('--rebind'), allowFileStore: args.includes('--allow-file-token-store') });
      if (json) { print(result); }
      else {
        const b = (result as any).binding;
        console.log(box([
          section(result.alreadyBound ? 'Workspace already bound' : 'Workspace bound'),
          kv('Server', b.server),
          kv('Product ID', String(b.productId)),
          kv('Repository ID', String(b.repositoryId)),
          kv('Repository remote', b.repositoryRemote),
          kv('Git root', b.gitRoot),
          kv('Sync mode', 'manual (run `notchlet sync mode auto` to enable automatic sync)'),
        ]));
      }
    }
    else if (command === 'workspace' && positional[1] === 'info') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('workspace info', `notchlet workspace info

  Show the current workspace binding and configuration.

Options:
  --workspace <root> / --root <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('workspace info');
      const workspaceFile = path.join(root, '.notchlet', 'workspace.json');
      let workspaceData: any = {};
      try {
        workspaceData = JSON.parse(await readFile(workspaceFile, 'utf8'));
      } catch {
        workspaceData = {};
      }
      if (json) { print(workspaceData); }
      else {
        const lines: string[] = [];
        lines.push(section('Workspace info'));
        lines.push(kv('Root', root));
        lines.push(kv('Sync mode', workspaceData.preferences?.syncMode ?? 'manual'));
        const b = workspaceData.binding;
        if (b) {
          lines.push(divider());
          lines.push(section('Binding'));
          lines.push(kv('Server', b.server));
          lines.push(kv('Server identity', b.serverIdentity));
          lines.push(kv('Product ID', String(b.productId)));
          lines.push(kv('Repository ID', String(b.repositoryId)));
          lines.push(kv('Repository remote', b.repositoryRemote));
          lines.push(kv('Git root', b.gitRoot));
          lines.push(kv('Endpoint', b.endpoint ?? '(default)'));
          lines.push(kv('Core version', b.coreVersion ?? '(unknown)'));
          lines.push(kv('Schema version', b.schemaVersion ?? '(unknown)'));
          if (b.protocol) lines.push(kv('Protocol', JSON.stringify(b.protocol)));
        } else {
          lines.push(divider());
          lines.push(section('Binding'));
          lines.push(warn('Not bound. Run `notchlet workspace bind` to connect.'));
        }
        console.log(box(lines));
      }
    }
    else if (command === 'doctor') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('doctor', `notchlet doctor [--server <url>]

  Diagnose workspace, binding, git, and server connectivity.

Options:
  --server <url>             Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>           Override MCP endpoint
  --allow-file-token-store   Allow restricted file credential storage
  --json                     Machine-readable JSON output`);
      }
      const root = await workspace();
      const { doctor } = await import('./integration.js');
      const result = await doctor(root, { server: optionValue('--server'), endpoint: optionValue('--endpoint'), allowFileStore: args.includes('--allow-file-token-store') });
      if (json) { print(result); }
      else {
        const p = result.profile;
        const lines: string[] = [];
        lines.push(section('Notchlet doctor'));
        lines.push(kv('Server', p?.origin ?? '(none)'));
        lines.push(kv('Auth mode', p?.authMode ?? '(none)'));
        lines.push(kv('Backend', result.online ? ok('reachable') : err('offline')));
        lines.push(kv('Diagnostic', result.diagnostic));
        lines.push(kv('Git', result.git.isRepository ? ok(result.git.repository.topLevel) : err(result.git.reason ?? 'not a repository')));
        lines.push(kv('Binding', result.binding ? ok('configured') : err('none')));
        if (result.capabilities) lines.push(kv('Server version', result.capabilities.server?.version ?? '(unknown)'));
        if (result.authScopes?.length) lines.push(kv('Auth scopes', result.authScopes.join(', ')));
        console.log(box(lines));
      }
    }
    else if (command === 'sync' && positional[1] === 'mode') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('sync mode', `notchlet sync mode auto|manual

  Set automatic sync preference for the workspace.

Options:
  --workspace <root> / --root <root>   Set workspace root
  --json           Machine-readable JSON output`);
      }
      const root = await requireWorkspace('sync mode');
      const mode = positional[2] ?? (isTty() ? await prompt('Sync mode (auto|manual): ') : undefined);
      if (mode !== 'auto' && mode !== 'manual') fail('usage_error', usage, 'Choose `notchlet sync mode auto` or `notchlet sync mode manual`.', 64);
      const { setWorkspaceSyncMode } = await import('./integration.js');
      const result = await setWorkspaceSyncMode(root, mode);
      if (json) print({ ...result, workspace: root });
      else console.log(box([
        section('Sync mode updated'),
        kv('Workspace', root),
        kv('Sync mode', result.syncMode),
      ]));
    }
    else if (command === 'sync') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('sync', `notchlet sync <action> --change <name|id> [--yes] [--keep-local]

  status   Show sync state of a change
  push     Push local change to remote
  pull     Pull remote change to local
  resolve  Resolve a conflict (requires --keep-local)

Options:
  --change <name|id>   Change name or ID (required)
  --yes                Skip confirmation prompt
  --keep-local         Keep local changes when resolving (required for resolve)
  --server <url>       Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>     Override MCP endpoint
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('sync');
      const action = positional[1];
      let id = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
      if (!['status', 'push', 'pull', 'resolve'].includes(action ?? '') || !id) fail('usage_error', usage, 'Use `notchlet sync <status|push|pull|resolve> --change <name|id> [--yes] [--keep-local]`.', 64);
      id = await resolveChangeRef(root, id);
      const { syncStatus, syncPush, syncPull, syncResolve } = await import('./integration.js');
      const syncOptions = { server: optionValue('--server'), endpoint: optionValue('--endpoint'), yes: args.includes('--yes') };
      if (action === 'status') {
        const automaticSync = await syncIfAutomatic(root, id);
        const result = await syncStatus(root, id, syncOptions);
        if (json) { print({ ...result, ...(automaticSync ? { automaticSync } : {}) }); }
        else {
          const lines: string[] = [];
          lines.push(section(`Sync status: ${id}`));
          lines.push(kv('State', result.state));
          lines.push(kv('Remote ID', result.remoteId ?? '(none)'));
          lines.push(kv('Local hash', result.localHash));
          lines.push(kv('Remote hash', result.remoteHash ?? '(none)'));
          lines.push(kv('Base hash', result.baseHash ?? '(none)'));
          lines.push(kv('Remote captured at', result.remoteCapturedAt ?? '(none)'));
          if (automaticSync) lines.push(kv('Automatic sync', (automaticSync as any).state ?? 'pending'));
          console.log(box(lines));
        }
      } else {
        const yes = args.includes('--yes');
        if (!yes && action !== 'status' && isTty()) {
          const confirmed = await confirm(`Are you sure you want to \`${action}\` change ${id}?`);
          if (!confirmed) { console.log(warn('Cancelled.')); return; }
        }
        const result = action === 'push' ? await syncPush(root, id, syncOptions) : action === 'pull' ? await syncPull(root, id, syncOptions) : await syncResolve(root, id, 'keep-local', syncOptions);
        if (json) { print(result); }
        else {
          const lines: string[] = [];
          lines.push(section(`Sync ${action}: ${id}`));
          lines.push(kv('State', result.state));
          lines.push(kv('Remote ID', result.remoteId ?? '(none)'));
          if ((result as any).revision !== undefined) lines.push(kv('Revision', String((result as any).revision)));
          if ((result as any).hash) lines.push(kv('Hash', (result as any).hash));
          if ((result as any).nextAction) lines.push(kv('Next action', (result as any).nextAction));
          if ((result as any).conflict) lines.push(kv('Conflict', warn((result as any).conflict)));
          if ((result as any).automatic) lines.push(kv('Automatic', 'yes'));
          console.log(box(lines));
        }
      }
    }
    else if (command === 'client') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('client', `notchlet client init|update opencode|claude [--apply]

  init    Install all Notchlet client guidance skills
  update  Update all installed Notchlet client guidance skills

Skills installed:
  notchlet-mcp, notchlet-platform, notchlet-plan, notchlet-implement, notchlet-review, notchlet-deliver, notchlet-super, notchlet-init

Targets:
  opencode   .opencode/skills/<skill>/SKILL.md
  claude     .claude/skills/<skill>/SKILL.md

Options:
  --apply    Actually write the guidance files (without this, only previews)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('client');
      const action = positional[1], client = positional[2];
      if (!['init', 'update'].includes(action ?? '') || !['opencode', 'claude'].includes(client ?? '')) fail('usage_error', usage, 'Use `notchlet client init|update opencode|claude [--apply]`.', 64);
      const { installClientGuidance } = await import('./guidance-install.js');
      const result = await installClientGuidance(root, client as 'opencode' | 'claude', { apply: args.includes('--apply') });
      if (json) { print(result); }
      else {
        const lines: string[] = [];
        lines.push(section(`Client guidance: ${result.action}`));
        lines.push(kv('Client', result.client));
        const appliedCount = result.results.filter(r => r.applied).length;
        lines.push(kv('Skills', `${appliedCount}/${result.results.length} ${result.applied ? ok('applied') : warn('preview (use --apply to install)')}`));
        for (const r of result.results) {
          const status = r.applied ? ok(r.action) : r.action === 'unchanged' ? warn('unchanged') : err(r.action);
          lines.push(kv(r.skill, `${status}${r.reason ? ` - ${r.reason}` : ''}`));
        }
        console.log(box(lines));
      }
    }
    else if (command === 'checkpoint') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('checkpoint', `notchlet checkpoint --change <name|id> --name <name> [--summary <text>] [--backlog-status TODO|IN_PROGRESS|IN_REVIEW|DONE]

  Create a remote checkpoint on a synchronized change.

Options:
  --change <name|id>         Change name or ID (required)
  --name <name>              Checkpoint name (required, max 100 chars)
  --summary <text>           Checkpoint summary (max 4096 chars)
  --backlog-status <status>  Backlog status: TODO, IN_PROGRESS, IN_REVIEW, or DONE
  --server <url>             Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>           Override MCP endpoint
  --workspace <root>         Set workspace root
  --json                     Machine-readable JSON output`);
      }
      const root = await requireWorkspace('checkpoint');
      const changeRef = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
      const name = optionValue('--name') ?? (isTty() && !changeRef ? await prompt('Checkpoint name: ') : undefined);
      const backlogStatus = optionValue('--backlog-status');
      if (!changeRef || !name || (backlogStatus !== undefined && !['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'].includes(backlogStatus))) fail('usage_error', usage, 'Provide --change, --name, and an optional supported --backlog-status.', 64);
      const id = await resolveChangeRef(root, changeRef);
      const { syncCheckpoint } = await import('./integration.js');
      const result = await syncCheckpoint(root, id, { name, ...(optionValue('--summary') === undefined ? {} : { summary: optionValue('--summary') }), ...(backlogStatus === undefined ? {} : { backlogStatus: backlogStatus as 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' }) }, { server: optionValue('--server'), endpoint: optionValue('--endpoint') });
      if (json) { print(result); }
      else {
        const c = (result as any).checkpoint;
        const lines: string[] = [];
        lines.push(section('Checkpoint created'));
        lines.push(kv('Change', id));
        lines.push(kv('Remote ID', result.remoteId));
        lines.push(kv('Name', c?.name ?? name));
        lines.push(kv('Snapshot revision', String(c?.snapshotRevision ?? '(unknown)')));
        if (c?.summary) lines.push(kv('Summary', c.summary));
        if (c?.backlogStatus) lines.push(kv('Backlog status', c.backlogStatus));
        console.log(box(lines));
      }
    }
    else if (command === 'evidence' && positional[1] === 'record') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('evidence record', `notchlet evidence record --change <name|id> --file <json-path>

  Record evidence for a change.

Options:
  --change <name|id>  Change name or ID (required)
  --file <path>    Path to evidence JSON file (required, max 32 KiB)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('evidence record');
      const changeRef = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
      const file = optionValue('--file') ?? (isTty() && !changeRef ? await prompt('Evidence JSON file path: ') : undefined);
      if (!changeRef || !file) fail('usage_error', usage, 'Provide --change and --file for evidence record.', 64);
      const id = await resolveChangeRef(root, changeRef);
      const source = await readFile(path.resolve(process.cwd(), file), 'utf8');
      if (Buffer.byteLength(source, 'utf8') > EVIDENCE_INPUT_LIMIT_BYTES) fail('payload_too_large', 'Evidence input exceeds 32 KiB.', 'Split the evidence into smaller records and try again.', 5);
      let value: unknown;
      try { value = JSON.parse(source); } catch { fail('invalid_input', 'Evidence input is not valid JSON.', 'Correct the JSON file and try again.', 2); }
      const evidence = await appendEvidence(root, id, parseEvidenceWriteInput(value));
      printWithSync(evidence, await syncIfAutomatic(root, id), `Recorded ${evidence.kind} evidence ${evidence.id} for ${id}.`);
    }
    else if (command === 'backlog' && positional[1] === 'import') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('backlog import', `notchlet backlog import <item-key|title|id> [--product-id <id>]

  Import a backlog item as a change.

Options:
  <item-key|title|id>  Backlog key, title, or numeric ID
  --product-id <id>    Product ID (defaults to the workspace binding)
  --server <url>     Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>   Override MCP endpoint
  --allow-file-token-store   Allow restricted file credential storage
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('backlog import');
      const itemQuery = positional[2] ?? (isTty() ? await prompt('Backlog item key or title: ') : undefined);
      if (!itemQuery) fail('usage_error', usage, 'Provide a backlog key/title/ID, for example `APP-42` or `Improve onboarding`.', 64);
      let productId = Number(optionValue('--product-id'));
      if (!Number.isSafeInteger(productId) || productId < 1) {
        try { productId = Number(JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8')).binding?.productId); }
        catch { productId = NaN; }
      }
      if (!Number.isSafeInteger(productId) || productId < 1) fail('product_required', 'No product is selected for this workspace.', 'Run `notchlet init` or `notchlet workspace bind`, or pass --product-id.', 64);
      let itemId = Number(itemQuery);
      if (!Number.isSafeInteger(itemId) || itemId < 1) {
        const { platformApi } = await import('./integration.js');
        const api = await platformApi(optionValue('--server'), { allowFileStore: args.includes('--allow-file-token-store') });
        const items = await api.get(`/backlog?productId=${productId}`) as any[];
        const selected = await pickNamedValue(itemQuery, items, {
          kind: 'Backlog item', promptText: 'Select backlog item',
          label: item => `${item.key ? `${item.key} · ` : ''}${item.title} · ${item.status ?? item.itemType ?? 'item'} (#${item.id})`,
          keys: item => [item.key, item.title, String(item.id)].filter(Boolean),
        });
        if (!selected) fail('backlog_item_not_found', `No backlog item matched "${itemQuery}" in product ${productId}.`, 'Check the item key/title or select the correct product with --product-id.', 2);
        itemId = Number(selected.id);
      }
      if (!Number.isSafeInteger(itemId) || itemId < 1) fail('usage_error', usage, 'Provide a valid backlog key, title, or numeric ID.', 64);
      const { importBacklogItem } = await import('./integration.js');
      const change = await importBacklogItem(root, { itemId, productId, server: optionValue('--server'), endpoint: optionValue('--endpoint'), allowFileStore: args.includes('--allow-file-token-store') });
      printWithSync({ change }, await syncIfAutomatic(root, change.id), `Imported backlog item ${itemId} as change ${change.id}.`);
    }
    else if (command === 'mcp') {
      const action = positional[1];
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('mcp', `notchlet mcp <action> [options]

  serve      Run the local stdio MCP bridge for OpenCode/Claude
  status     Show MCP setup, credential presence, and project config state
  disconnect Remove this project's Notchlet MCP entry (and optionally revoke)
  revoke     Revoke the generated MCP credential and delete its local secret

Options:
  --server <url>         Notchlet server (default: ${DEFAULT_SERVER})
  --client <name>        opencode or claude
  --credential-id <id>   Credential to revoke (revoke)
  --revoke               Also revoke the account credential (disconnect)
  --yes                  Skip confirmation prompts
  --workspace <root>     Set workspace root (serve, status, disconnect, revoke)
  --json                 Machine-readable JSON output (status/disconnect/revoke)

The bridge reads its credential from the OS credential store; secrets are never
passed on the command line or written to project configuration.`);
      }
      const clientOption = optionValue('--client');
      if (clientOption !== undefined && !['opencode', 'claude'].includes(clientOption)) fail('usage_error', usage, 'Use --client opencode or --client claude.', 64);
      const client = clientOption as 'opencode' | 'claude' | undefined;
      if (action === 'serve') {
        const { serveMcp } = await import('./mcp-bridge.js');
        const { redactMcpText } = await import('./mcp-bridge.js');
        try {
          await serveMcp(serverOption(), { client, workspace: optionValue('--workspace') ?? explicitRoot });
        } catch (error) {
          process.stderr.write(`notchlet mcp serve: ${redactMcpText(error instanceof Error ? error.message : String(error))}\n`);
          process.exitCode = 1;
        }
      } else if (action === 'status') {
        const root = await workspace();
        const { mcpStatus, mcpClientLabel } = await import('./mcp-onboarding.js');
        const result = await mcpStatus({ root, server: optionValue('--server'), client });
        if (json) { print(result); }
        else {
          const lines: string[] = [section('MCP status')];
          lines.push(kv('Workspace', result.root ?? '(none)'));
          if (!result.servers.length) lines.push(warn('No MCP configuration is recorded for this workspace. Run `notchlet init --interactive` to configure it.'));
          for (const server of result.servers) {
            lines.push(divider());
            lines.push(kv('Server', server.server));
            if (server.credential) {
              lines.push(kv('Credential', `${server.credential.name}${server.credential.id ? ` (id ${server.credential.id})` : ''}`));
              lines.push(kv('Scopes', server.credential.scopes.join(', ') || '(none)'));
              lines.push(kv('Keyring', server.credential.keyring === 'present' ? ok('present') : server.credential.keyring === 'missing' ? err('missing') : warn('unavailable')));
            } else {
              lines.push(kv('Credential', warn('none recorded')));
            }
            if (server.account) {
              const account = server.account.enabled === true ? ok('enabled') : server.account.enabled === false ? warn('disabled') : warn(`unknown${server.account.error ? ` - ${server.account.error}` : ''}`);
              lines.push(kv('Account MCP', account));
            }
            for (const entry of server.clients) {
              const state = entry.state === 'configured' ? ok('configured') : entry.state === 'modified' ? warn('modified (preserved)') : entry.state === 'invalid' ? err('invalid') : warn('missing');
              lines.push(kv(mcpClientLabel(entry.client), `${state} - ${entry.path}${entry.reason ? ` (${entry.reason})` : ''}`));
            }
          }
          console.log(box(lines));
        }
      } else if (action === 'disconnect') {
        const root = await requireWorkspace('mcp disconnect');
        const yes = args.includes('--yes');
        if (!yes && !isTty()) fail('confirmation_required', 'MCP disconnect changes project configuration and requires confirmation.', 'Pass --yes to confirm in non-interactive mode.', 64);
        const { mcpDisconnect, mcpClientLabel } = await import('./mcp-onboarding.js');
        const result = await mcpDisconnect({
          root,
          server: optionValue('--server'),
          client,
          revoke: args.includes('--revoke'),
          yes,
          confirm: (message) => confirm(message),
          allowFileStore: args.includes('--allow-file-token-store'),
        });
        if (json) { print(result); }
        else {
          const lines: string[] = [section('MCP disconnect')];
          if (result.message) lines.push(warn(result.message));
          for (const entry of result.removed) {
            const state = entry.action === 'removed' ? ok('removed') : entry.action === 'conflict' ? err('conflict') : warn('not configured');
            lines.push(kv(mcpClientLabel(entry.client), `${state} - ${entry.path}${entry.reason ? ` (${entry.reason})` : ''}`));
          }
          if (result.credential) {
            lines.push(kv('Credential', `${result.credential.name}${result.credential.id ? ` (id ${result.credential.id})` : ''}`));
            lines.push(kv('Revoked', result.credential.revoked ? ok('yes') : warn('no')));
            lines.push(kv('Keyring', result.credential.keyring === 'removed' ? ok('removed') : result.credential.keyring === 'missing' ? warn('missing') : warn('kept')));
            if (result.credential.message) lines.push(kv('Note', warn(result.credential.message)));
          }
          console.log(box(lines));
        }
      } else if (action === 'revoke') {
        const root = await workspace();
        const yes = args.includes('--yes');
        if (!yes && !isTty()) fail('confirmation_required', 'MCP credential revocation requires confirmation.', 'Pass --yes to confirm in non-interactive mode.', 64);
        const { mcpRevoke } = await import('./mcp-onboarding.js');
        const rawId = optionValue('--credential-id');
        const credentialId = rawId === undefined ? undefined : Number(rawId);
        if (credentialId !== undefined && (!Number.isSafeInteger(credentialId) || credentialId < 1)) fail('usage_error', usage, 'Provide a numeric --credential-id.', 64);
        const result = await mcpRevoke({
          root,
          server: optionValue('--server'),
          credentialId,
          yes,
          confirm: (message) => confirm(message),
          allowFileStore: args.includes('--allow-file-token-store'),
        });
        if (json) { print(result); }
        else {
          const lines: string[] = [section('MCP credential revoked')];
          lines.push(kv('Server', result.origin));
          if (result.credentialName) lines.push(kv('Credential', `${result.credentialName}${result.credentialId ? ` (id ${result.credentialId})` : ''}`));
          lines.push(kv('Remote revocation', result.revoked ? ok('revoked') : warn('already revoked or not found')));
          lines.push(kv('Keyring', result.keyring === 'removed' ? ok('removed') : result.keyring === 'missing' ? warn('missing') : warn('kept')));
          if (result.message) lines.push(kv('Note', warn(result.message)));
          console.log(box(lines));
        }
      } else fail('usage_error', usage, 'Use `notchlet mcp serve|status|disconnect|revoke`.', 64);
    }
    else if (command === 'init') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('init', `notchlet init [path] [--local|--interactive]

  Initialize a Notchlet workspace in the given path (or current directory).

Options:
  --local              Initialize local-only mode (no account login)
  --interactive        Force interactive setup (prompts for server, org, product, repository)
  --workspace <root> / --root <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = path.resolve(positional[1] ?? explicitRoot ?? process.cwd());
      if (args.includes('--interactive') && json) fail('usage_error', usage, 'Interactive setup cannot be combined with --json.', 64);
      const interactive = args.includes('--interactive') || (!args.includes('--local') && !json && Boolean(process.stdin.isTTY && process.stderr.isTTY));
      if (interactive) {
        const { interactiveInit } = await import('./setup.js');
        const result = await interactiveInit(root);
        if (json) { print(result); }
        else {
          const lines: string[] = [];
          lines.push(section('Workspace initialized'));
          lines.push(kv('Root', result.root));
          lines.push(kv('Mode', result.mode));
          if (result.accountConnected) lines.push(kv('Account connected', 'yes'));
          if (result.organizationId) lines.push(kv('Organization ID', String(result.organizationId)));
          if (result.productId) lines.push(kv('Product ID', String(result.productId)));
          if (result.syncMode) lines.push(kv('Sync mode', result.syncMode));
          if (result.guidance) {
            const guidance = result.guidance as { client: string; results: Array<{ applied: boolean; action: string }> };
            const applied = guidance.results.filter(item => item.applied).length;
            const conflicts = guidance.results.filter(item => item.action === 'conflict').length;
            const clientName = guidance.client === 'opencode' ? 'OpenCode' : 'Claude Code';
            lines.push(kv('Agent skills', `${applied} installed for ${clientName}${conflicts ? `; ${conflicts} conflict(s) preserved` : ''}`));
          }
          if (result.mcp) {
            const mcp = result.mcp;
            const clientName = mcp.client === 'opencode' ? 'OpenCode' : 'Claude Code';
            const state = mcp.status === 'configured'
              ? ok(`configured for ${clientName}${typeof mcp.toolCount === 'number' && mcp.toolCount > 0 ? ` (${mcp.toolCount} tools verified)` : ''}`)
              : mcp.status === 'configured-unverified'
                ? warn(`written for ${clientName}; live verification failed${mcp.message ? ` - ${mcp.message}` : ''}`)
                : mcp.status === 'conflict'
                  ? err(`conflict for ${clientName}${mcp.message ? ` - ${mcp.message}` : ''}`)
                  : warn(`skipped for ${clientName}${mcp.message ? ` - ${mcp.message}` : ''}`);
            lines.push(kv('MCP access', state));
          }
          if (result.message) lines.push(kv('Message', result.message));
          if (result.binding) {
            lines.push(divider());
            lines.push(section('Binding'));
            // interactiveInit wraps bindWorkspace's result, which itself wraps
            // the persisted binding together with rebound/alreadyBound metadata.
            const bindingResult = result.binding as any;
            const b = bindingResult.binding ?? bindingResult;
            lines.push(kv('Server', b.server));
            lines.push(kv('Product ID', String(b.productId)));
            lines.push(kv('Repository ID', String(b.repositoryId)));
            lines.push(kv('Repository remote', b.repositoryRemote));
          }
          console.log(box(lines));
        }
      }
      else { await initWorkspace(root); print({ root, initialized: true, mode: 'local' }, `Initialized Notchlet workspace at ${root} (local mode).`); }
    } else if (command === 'change') {
      const action = positional[1];
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('change', `notchlet change <action> [options]

  new <name> [--quick]           Create a new change
  list                           List all changes
  show <name|id>                 Show change details and readiness
  convert <name|id> --schema <q|s> Convert a change schema
  close <name|id> --preview | --baseline-revision <n>   Close and archive a change

Options:
  --quick                  Create a quick (minimal) change
  --schema quick|standard  Schema for conversion (required for convert)
  --preview                Preview closure without changing files (for close)
  --baseline-revision <n>  Baseline revision for closing (required for close)
  --yes                    Skip confirmation prompt (for close)
  --workspace <root>       Set workspace root
  --json                   Machine-readable JSON output`);
      }
      if (action === 'new') {
        const name = positional[2] ?? (isTty() ? await prompt('Change name: ') : undefined);
        if (!name) fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
        const root = await requireWorkspace('change new');
        const change = await scaffold(root, name, args.includes('--quick') ? 'quick' : 'standard');
        printWithSync(change, await syncIfAutomatic(root, change.id), `Created change ${change.id}: ${change.name}.`);
      } else if (action === 'list') {
        const root = await workspace();
        if (!root) { print({ changes: [] }, 'No Notchlet workspace found.'); }
        else {
          const changes = await listChanges(root);
          if (json) { print({ workspace: root, changes }); }
          else {
            console.log(section(`Changes in ${root}`));
            if (changes.length === 0) { console.log(warn('(none)')); }
            else {
              const rows = changes.map((c: any) => [c.id, c.name, String(c.taskCount ?? 0), c.ready ? ok('ready') : err('not ready')]);
              console.log(table(['ID', 'Name', 'Tasks', 'Ready'], rows));
            }
          }
        }
      } else if (action === 'show') {
        const root = await requireWorkspace('change show');
        const changeRef = positional[2] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        const id = changeRef ? await resolveChangeRef(root, changeRef) : undefined;
        if (!id) fail('usage_error', usage, 'Provide a change name or ID from `notchlet change list`.', 64);
        const change = await readChange(root, id);
        const result = { change, readiness: readiness(change, await artifactContents(root, id, change)) };
        if (json) { printWithSync(result, await syncIfAutomatic(root, id)); }
        else {
          const lines: string[] = [];
          lines.push(section(`Change: ${id}`));
          lines.push(kv('Name', change.name));
          lines.push(kv('Mode', change.mode));
          lines.push(kv('Revision', String(change.revision ?? 0)));
          lines.push(kv('Intent', change.intent));
          lines.push(kv('Outcome', change.outcome));
          lines.push(kv('Requirements', String(change.requirements.length)));
          lines.push(kv('Checks', String(change.checks.length)));
          lines.push(kv('Tasks', String(change.tasks.length)));
          lines.push(divider());
          lines.push(section('Artifacts'));
          const artifactNames = Object.keys(change.artifacts);
          if (artifactNames.length === 0) lines.push(warn('(none)'));
          else for (const name of artifactNames) lines.push(bullet(`${name}: ${change.artifacts[name]}`));
          lines.push(divider());
          lines.push(section('Readiness'));
          lines.push(kv('Ready', result.readiness.ready ? ok('yes') : err('no')));
          if (result.readiness.blockers?.length) {
            lines.push(section('Blockers'));
            for (const b of result.readiness.blockers) lines.push(bullet(String(b.message ?? b)));
          } else {
            lines.push(bullet('No blockers.'));
          }
          console.log(box(lines));
        }
      } else if (action === 'convert') {
        const root = await requireWorkspace('change convert');
        const changeRef = positional[2] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        const schema = optionValue('--schema') ?? (isTty() && !changeRef ? await prompt('Schema (quick|standard): ') : undefined);
        if (!changeRef || (schema !== 'quick' && schema !== 'standard')) fail('usage_error', usage, 'Use `--schema quick` or `--schema standard`.', 64);
        const id = await resolveChangeRef(root, changeRef);
        const change = await persistConversion(root, id, schema);
        const result = { change, readiness: readiness(change, await artifactContents(root, id, change)) };
        printWithSync(result, await syncIfAutomatic(root, id), `Converted change ${id} to ${schema} schema.`);
      } else if (action === 'close') {
        const root = await requireWorkspace('change close');
        const changeRef = positional[2] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        if (!changeRef) fail('usage_error', usage, 'Provide a change name or ID.', 64);
        const id = await resolveChangeRef(root, changeRef);
        if (args.includes('--preview')) {
          const preview = await previewCapabilityClose(root, id);
          if (json) { print(preview); }
          else {
            const lines: string[] = [];
            lines.push(section(`Closure preview: ${id}`));
            if (preview.baselineName) lines.push(kv('Baseline name', preview.baselineName));
            if (preview.baselineRevision !== undefined) lines.push(kv('Baseline revision', String(preview.baselineRevision)));
            if (preview.additions?.length) lines.push(kv('Additions', String(preview.additions.length)));
            if (preview.updates?.length) lines.push(kv('Updates', String(preview.updates.length)));
            if (preview.removals?.length) lines.push(kv('Removals', String(preview.removals.length)));
            if (preview.blockers?.length) {
              lines.push(section('Blockers'));
              for (const b of preview.blockers) lines.push(bullet(`${b.code}: ${b.message}`));
            }
            console.log(box(lines));
            console.log(warn('No files were changed.'));
          }
        } else {
          const yes = args.includes('--yes');
          if (!yes && isTty()) {
            const confirmed = await confirm(`Are you sure you want to close and archive change ${id}?`);
            if (!confirmed) { console.log(warn('Cancelled.')); return; }
          }
          const revision = Number(optionValue('--baseline-revision'));
          if (!Number.isInteger(revision) || revision < 0) fail('usage_error', usage, 'Provide --baseline-revision from the capability preview.', 64);
          print(await closeChange(root, id, { expectedBaselineRevision: revision }), `Closed and archived ${id}.`);
        }
      } else fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
    } else if (command === 'task') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('task', `notchlet task <action> [options]

  start <task-name|id> --change <name|id> --revision <n>    Start a task
  complete <task-name|id> --change <name|id> --revision <n> Complete a task
  update <change-name|id> <task-name|id> <status> <revision> Update a task status

Options:
  --change <name|id>  Change name or ID (required for start/complete)
  --revision <n>    Revision number (required)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('task');
      const action = positional[1];
      let id: string | undefined, taskId: string | undefined, status: string | undefined, revisionText: string | undefined;
      if (action === 'start' || action === 'complete') {
        taskId = positional[2] ?? (isTty() ? await prompt('Task name or ID: ') : undefined);
        id = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        status = action === 'start' ? 'in_progress' : 'completed';
        revisionText = optionValue('--revision') ?? (isTty() ? await prompt('Revision: ') : undefined);
      } else if (action === 'update') {
        [, , id, taskId, status, revisionText] = positional;
        id = id ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        taskId = taskId ?? (isTty() ? await prompt('Task name or ID: ') : undefined);
        status = status ?? (isTty() ? await prompt('Status (pending|in_progress|completed): ') : undefined);
        revisionText = revisionText ?? (isTty() ? await prompt('Revision: ') : undefined);
      }
      if (!id || !taskId || !['pending', 'in_progress', 'completed'].includes(status ?? '') || !revisionText || !Number.isInteger(Number(revisionText))) fail('usage_error', usage, 'Use task start|complete <task-name|id> --change <change-name|id> --revision <n>, or task update <change-name|id> <task-name|id> <status> <revision>.', 64);
      const changeMatches = await listChanges(root);
      const selectedChange = await pickNamedValue(id, changeMatches, {
        kind: 'Change', promptText: 'Select change',
        label: item => `${item.name} (${item.id})`, keys: item => [item.id, item.name],
      });
      if (!selectedChange) fail('change_not_found', `No change matched "${id}".`, 'Run `notchlet change list` and use a change name or ID.', 2);
      id = selectedChange.id;
      const localChange = await readChange(root, id);
      const selectedTask = await pickNamedValue(taskId, localChange.tasks, {
        kind: 'Task', promptText: 'Select task',
        label: item => `${item.title} (${item.id}) · ${item.status}`,
        keys: item => [item.id, item.title],
      });
      if (!selectedTask) fail('task_not_found', `No task matched "${taskId}" in change "${localChange.name}".`, 'Use a task name or ID from `notchlet change show`.', 2);
      taskId = selectedTask.id;
      const change = await transitionTask(path.join(root, '.notchlet', 'changes', id, 'tasks.json'), taskId, status as TaskStatus, Number(revisionText));
      printWithSync(change, await syncIfAutomatic(root, id), `Task ${taskId} marked ${status} in change ${id}.`);
    } else if (['status', 'validate', 'instructions'].includes(command)) {
      if (args.includes('--help') || args.includes('-h')) {
        const helpText = command === 'status'
          ? `notchlet status [change-name|id]

  Show workspace status, or status of a specific change.

Options:
  [change-name|id]  Change name or ID (optional; lists all changes if omitted)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`
          : command === 'validate'
          ? `notchlet validate <change>

  Validate that a change is ready.

Options:
  <change>     Change name or ID (required)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`
          : `notchlet instructions <change-name|id> [--action <action>]

  Get workflow instructions for a change.

Options:
  <change>     Change name or ID (required)
  --action plan|revise|implement|verify|resume   Action to get instructions for (default: resume)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`;
        showCommandHelp(command, helpText);
      }
      const root = await profileAsync('workspaceResolution', workspace);
      if (!root) {
        if (command === 'validate') fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root.', 2);
        print({ coreVersion: CORE_VERSION, workspace: null, changes: [] }, `No Notchlet workspace found. Core engine ${CORE_VERSION}.`);
      } else {
        const changeRef = positional[1] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        if (!changeRef) {
          if (command !== 'status') fail('usage_error', usage, `Provide a change name or ID for ${command}.`, 64);
          const changes = await listChanges(root);
          if (json) { print({ protocolVersion: 1, coreVersion: CORE_VERSION, workspace: root, changes }); }
          else {
            console.log(section(`Changes in ${root}`));
            if (changes.length === 0) { console.log(warn('No changes found.')); }
            else {
              const rows = changes.map((c: any) => [c.id, c.name, String(c.taskCount ?? 0), c.ready ? ok('ready') : err('not ready')]);
              console.log(table(['ID', 'Name', 'Tasks', 'Ready'], rows));
            }
          }
        }
        else {
          if (positional.length !== 2 && !(isTty() && positional.length === 1)) fail('usage_error', usage, 'Provide exactly one change name or ID.', 64);
          const id = await resolveChangeRef(root, changeRef);
          const change = await profileAsync('changeReadAndParse', () => readChange(root, id));
          const automaticSync = await profileAsync('automaticSyncModeCheck', () => syncIfAutomatic(root, id));
          const contents = await profileAsync('artifactReads', () => artifactContents(root, id, change));
          if (command === 'status') {
            const state = profileSync('evaluateState', () => evaluateState(change, undefined, contents));
            const derivedState = profileSync('deriveState', () => deriveStatus(evaluateState(change)));
            const readinessState = profileSync('readinessProjection', () => ({ ready: state.planning.status === 'ready', blockers: state.planning.blockers.map(({ source: _source, ...issue }) => issue) }));
            if (json) { printWithSync({ protocolVersion: 1, coreVersion: CORE_VERSION, change: change.id, revision: change.revision ?? 0, state: derivedState, facets: state, readiness: readinessState }, automaticSync, `${change.name}: ${derivedState}\nCore engine: ${CORE_VERSION}\nEligible tasks: ${state.eligibleTasks.join(', ') || 'none'}\nBlockers: ${state.blockers.length}`); }
            else {
              const lines: string[] = [];
              lines.push(section(`Status: ${change.name} (${id})`));
              lines.push(kv('Revision', String(change.revision ?? 0)));
              lines.push(kv('Core engine', CORE_VERSION));
              lines.push(divider());
              lines.push(section('Progress'));
              lines.push(kv('Tasks', `${state.execution.completed}/${state.execution.total} completed${state.execution.inProgress ? `, ${state.execution.inProgress} in progress` : ''}`));
              lines.push(kv('Planning', state.planning.status));
              lines.push(kv('Verification', state.verification.status));
              lines.push(kv('Local closure', state.localClosure.status));
              lines.push(kv('Remote delivery', state.remoteDelivery.status));
              lines.push(divider());
              lines.push(section('Eligible tasks'));
              lines.push(state.eligibleTasks.length ? state.eligibleTasks.join(', ') : warn('none'));
              lines.push(divider());
              lines.push(section('Blockers'));
              if (state.blockers.length) for (const b of state.blockers) lines.push(bullet(String(b.message ?? b)));
              else lines.push(bullet('None.'));
              lines.push(divider());
              lines.push(kv('Readiness', readinessState.ready ? ok('ready') : err(`not ready (${readinessState.blockers.length} blocker(s))`)));
              console.log(box(lines));
            }
            if (profiling) process.stderr.write(`NOTCHLET_PROFILE ${JSON.stringify(profileTimings)}\n`);
          }
          else if (command === 'instructions') {
            const action = optionValue('--action') ?? 'resume';
            if (!['plan', 'revise', 'implement', 'verify', 'resume'].includes(action)) fail('usage_error', usage, 'Choose a documented action: plan, revise, implement, verify, or resume.', 64);
            const text = instructions(change, action as WorkflowAction);
            printWithSync({ protocolVersion: 1, coreVersion: CORE_VERSION, action, instructions: text }, automaticSync, `Core engine: ${CORE_VERSION}\n${text}`);
          }
          else {
            const result = readiness(change, contents);
            const data = automaticSync ? { readiness: result, automaticSync } : result;
            if (json) console.log(JSON.stringify(envelope(result.ready, data, result.ready ? null : { code: 'validation_failed', message: 'Change is not ready.', recovery: 'Resolve the listed blockers and validate again.' }, [])));
            else {
              const lines: string[] = [];
              lines.push(section(`Validate: ${change.name} (${id})`));
              lines.push(kv('Ready', result.ready ? ok('yes') : err('no')));
              if (result.blockers?.length) {
                lines.push(section('Blockers'));
                for (const b of result.blockers) lines.push(bullet(String(b.message ?? b)));
              } else {
                lines.push(bullet('No blockers.'));
              }
              console.log(box(lines));
            }
            if (!result.ready) process.exitCode = 1;
          }
        }
      }
    } else fail('unknown_command', usage, 'Run `notchlet --help` for available commands.', 64);
  } catch (error) {
    if (error instanceof Error && error.message === 'handled') { /* stable error already printed */ }
    else {
      const known = error instanceof WorkflowError ? error : null;
      const code = known?.code ?? 'operation_failed';
      const message = error instanceof Error ? error.message : String(error);
      const recovery = known?.recovery ?? 'Inspect the workspace and retry; existing files were not intentionally overwritten.';
      if (json) console.log(JSON.stringify(envelope(false, null, { code, message, recovery }, [])));
      else console.error(`${err(`${code}: ${message}`)}\nRecovery: ${recovery}`);
      process.exitCode = code === 'change_exists' ? 3 : 1;
    }
  }
}

main().catch(() => {});
