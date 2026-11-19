#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { appendEvidence, CORE_VERSION, closeChange, evaluateState, findWorkspace, initWorkspace, instructions, listChanges, persistConversion, previewCapabilityClose, readChange, readiness, scaffold, transitionTask, WorkflowError, type EvidenceWriteInput, type TaskStatus, type WorkflowAction, type CliJsonEnvelope } from '@notchlet/core';

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
  if (['--workspace', '--root', '--schema', '--action', '--server', '--product-id', '--repository-id', '--endpoint', '--item-id', '--change', '--name', '--snapshot-revision', '--summary', '--backlog-status', '--baseline-revision', '--revision', '--file'].includes(args[i])) { i++; continue; }
  if (!args[i].startsWith('--')) positional.push(args[i]);
}
const rootOption = args.find(arg => arg.startsWith('--workspace=') || arg.startsWith('--root='));
const explicitRoot = rootOption?.slice(rootOption.indexOf('=') + 1) ?? (args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : args.includes('--root') ? args[args.indexOf('--root') + 1] : undefined);
const workspace = () => findWorkspace(process.cwd(), explicitRoot);
const optionValue = (name: string): string | undefined => { const eq = args.find(arg => arg.startsWith(`${name}=`)); return eq ? eq.slice(name.length + 1) : args.includes(name) ? args[args.indexOf(name) + 1] : undefined; };
const command = args.includes('--version') ? 'version' : positional[0] ?? 'help';
const envelope = (ok: boolean, data: unknown = null, error: CliJsonEnvelope['error'] = null, warnings: unknown[] = []): CliJsonEnvelope => ({ protocolVersion: 1, command, ok, data, error, warnings });
function print(data: unknown, human?: string): void { console.log(json ? JSON.stringify(envelope(true, data)) : human ?? JSON.stringify(data, null, 2)); }
function fail(code: string, message: string, recovery: string, exitCode: number): never {
  if (json) console.log(JSON.stringify(envelope(false, null, { code, message, recovery }, [])));
  else console.error(`${code}: ${message}\nRecovery: ${recovery}`);
  process.exitCode = exitCode;
  throw new Error('handled');
}
const usage = 'Usage: notchlet init [path] [--local|--interactive] | auth login|status|logout [--server https://host] [--allow-file-token-store] | profile use --server https://host | workspace bind --server <origin> --product-id <id> --repository-id <id> [--rebind] | client init|update opencode|claude [--apply] | doctor | backlog import <item-id> --product-id <id> | sync mode auto|manual | sync status|push|pull|resolve --change <id> [--yes] [--keep-local] | checkpoint --change <id> --name <name> [--summary <text>] [--backlog-status TODO|IN_PROGRESS|IN_REVIEW|DONE] | evidence record --change <id> --file <json-path> | change new <name> [--quick] | change list | change show <id> | change convert <id> --schema quick|standard | change close <id> --preview | change close <id> --baseline-revision <n> | status [change] | validate <change> | instructions <change> [--action plan|revise|implement|verify|resume] | task start <task-id> --change <id> --revision <n> | task complete <task-id> --change <id> --revision <n> | task update <change> <task> <status> <revision> | --version';

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
  if (!automaticSync) return print(result, human);
  const syncState = (automaticSync as any)?.state ?? 'pending';
  print({ result, automaticSync }, `${human ?? JSON.stringify(result, null, 2)}\nAutomatic sync: ${syncState}`);
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

try {
  if (command === 'help' || args.includes('--help') || args.includes('-h')) { print({ usage }, usage); }
  else if (args.includes('--version') || command === 'version') { print({ version: '0.1.0', coreVersion: CORE_VERSION }, `notchlet 0.1.0 · @notchlet/core ${CORE_VERSION}`); }
  else if (command === 'auth') {
    const action = positional[1];
    if (!['login', 'status', 'logout'].includes(action ?? '')) fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
    const { authCommand } = await import('./auth.js');
    const result = await authCommand(action, { server: optionValue('--server'), allowFileStore: args.includes('--allow-file-token-store'), json });
    print(result);
  } else if (command === 'profile' && positional[1] === 'use') {
    const origin = optionValue('--server');
    if (!origin) fail('usage_error', usage, 'Select a server with `--server https://host`.', 64);
    const { selectProfile } = await import('./auth.js');
    const profile = await selectProfile(origin);
    if (!profile) fail('profile_not_found', 'No profile exists for this server.', 'Run `notchlet auth login --server https://host` first.', 2);
    print({ profile, current: true });
  }
  else if (command === 'workspace' && ['bind', 'rebind'].includes(positional[1] ?? '')) {
    const root = await workspace();
    if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the Git checkout root.', 2);
    const server = optionValue('--server'), productId = Number(optionValue('--product-id')), repositoryId = Number(optionValue('--repository-id'));
    if (!server || !Number.isSafeInteger(productId) || !Number.isSafeInteger(repositoryId)) fail('usage_error', usage, 'Provide --server, --product-id, and --repository-id.', 64);
    const { bindWorkspace } = await import('./integration.js');
    const result = await bindWorkspace(root, { server, productId, repositoryId, endpoint: optionValue('--endpoint'), rebind: positional[1] === 'rebind' || args.includes('--rebind') });
    print(result);
  }
  else if (command === 'doctor') {
    const root = await workspace();
    const { doctor } = await import('./integration.js');
    const result = await doctor(root, { server: optionValue('--server'), endpoint: optionValue('--endpoint'), allowFileStore: args.includes('--allow-file-token-store') });
    print(result, `Notchlet doctor: ${result.diagnostic}\nServer: ${result.profile?.origin ?? 'not selected'}\nBackend: ${result.online ? 'reachable' : 'offline'}\nGit: ${result.git.isRepository ? result.git.repository.topLevel : result.git.reason}\nBinding: ${result.binding ? 'configured' : 'none'}`);
  }
  else if (command === 'sync' && positional[1] === 'mode') {
    const root = await workspace();
    if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` first.', 2);
    const mode = positional[2];
    if (mode !== 'auto' && mode !== 'manual') fail('usage_error', usage, 'Choose `notchlet sync mode auto` or `notchlet sync mode manual`.', 64);
    const { setWorkspaceSyncMode } = await import('./integration.js');
    print({ ...(await setWorkspaceSyncMode(root, mode)), workspace: root });
  }
  else if (command === 'sync') {
    const root = await workspace();
    if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` and bind it with `notchlet workspace bind`.', 2);
    const action = positional[1], id = optionValue('--change');
    if (!['status', 'push', 'pull', 'resolve'].includes(action ?? '') || !id || (action === 'resolve' && !args.includes('--keep-local'))) fail('usage_error', usage, 'Use `notchlet sync resolve --change <id> --keep-local` after reviewing the conflict.', 64);
    const { syncStatus, syncPush, syncPull, syncResolve } = await import('./integration.js');
    const syncOptions = { server: optionValue('--server'), endpoint: optionValue('--endpoint'), yes: args.includes('--yes') };
    if (action === 'status') {
      const automaticSync = await syncIfAutomatic(root, id);
      const result = await syncStatus(root, id, syncOptions);
      print({ ...result, ...(automaticSync ? { automaticSync } : {}) }, JSON.stringify({ ...result, ...(automaticSync ? { automaticSync } : {}) }, null, 2));
    } else {
      const result = action === 'push' ? await syncPush(root, id, syncOptions) : action === 'pull' ? await syncPull(root, id, syncOptions) : await syncResolve(root, id, 'keep-local', syncOptions);
      print(result, JSON.stringify(result, null, 2));
    }
  }
  else if (command === 'client') {
    const root = await workspace();
    if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the checkout before installing client guidance.', 2);
    const action = positional[1], client = positional[2];
    if (!['init', 'update'].includes(action ?? '') || !['opencode', 'claude'].includes(client ?? '')) fail('usage_error', usage, 'Use `notchlet client init|update opencode|claude [--apply]`.', 64);
    const { installClientGuidance } = await import('./guidance-install.js');
    const result = await installClientGuidance(root, client as 'opencode' | 'claude', { apply: args.includes('--apply') });
    print(result, `Client guidance ${result.applied ? 'installed/updated' : 'preview'}: ${result.client} ${result.action} ${result.target}`);
  }
  else if (command === 'checkpoint') {
    const root = await workspace();
    if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` and bind it with `notchlet workspace bind`.', 2);
    const id = optionValue('--change'), name = optionValue('--name'), backlogStatus = optionValue('--backlog-status');
    if (!id || !name || (backlogStatus !== undefined && !['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'].includes(backlogStatus))) fail('usage_error', usage, 'Provide --change, --name, and an optional supported --backlog-status.', 64);
    const { syncCheckpoint } = await import('./integration.js');
    const result = await syncCheckpoint(root, id, { name, ...(optionValue('--summary') === undefined ? {} : { summary: optionValue('--summary') }), ...(backlogStatus === undefined ? {} : { backlogStatus: backlogStatus as 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' }) }, { server: optionValue('--server'), endpoint: optionValue('--endpoint') });
    print(result, JSON.stringify(result, null, 2));
  }
  else if (command === 'evidence' && positional[1] === 'record') {
    const root = await workspace();
    if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root.', 2);
    const id = optionValue('--change'), file = optionValue('--file');
    if (!id || !file) fail('usage_error', usage, 'Provide --change and --file for evidence record.', 64);
    const source = await readFile(path.resolve(process.cwd(), file), 'utf8');
    if (Buffer.byteLength(source, 'utf8') > EVIDENCE_INPUT_LIMIT_BYTES) fail('payload_too_large', 'Evidence input exceeds 32 KiB.', 'Split the evidence into smaller records and try again.', 5);
    let value: unknown;
    try { value = JSON.parse(source); } catch { fail('invalid_input', 'Evidence input is not valid JSON.', 'Correct the JSON file and try again.', 2); }
    const evidence = await appendEvidence(root, id, parseEvidenceWriteInput(value));
    printWithSync(evidence, await syncIfAutomatic(root, id), `Recorded ${evidence.kind} evidence ${evidence.id} for ${id}.`);
  }
  else if (command === 'backlog' && positional[1] === 'import') {
    const root = await workspace();
    if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root.', 2);
    const itemId = Number(positional[2]), productId = Number(optionValue('--product-id'));
    if (!Number.isSafeInteger(itemId) || !Number.isSafeInteger(productId)) fail('usage_error', usage, 'Provide numeric item ID and --product-id.', 64);
    const { importBacklogItem } = await import('./integration.js');
    const change = await importBacklogItem(root, { itemId, productId, server: optionValue('--server'), endpoint: optionValue('--endpoint'), allowFileStore: args.includes('--allow-file-token-store') });
    printWithSync({ change }, await syncIfAutomatic(root, change.id));
  }
  else if (command === 'init') {
    const root = path.resolve(positional[1] ?? explicitRoot ?? process.cwd());
    if (args.includes('--interactive') && json) fail('usage_error', usage, 'Interactive setup cannot be combined with --json.', 64);
    const interactive = args.includes('--interactive') || (!args.includes('--local') && !json && Boolean(process.stdin.isTTY && process.stderr.isTTY));
    if (interactive) {
      const { interactiveInit } = await import('./setup.js');
      print(await interactiveInit(root));
    }
    else { await initWorkspace(root); print({ root, initialized: true, mode: 'local' }); }
  } else if (command === 'change') {
    const action = positional[1];
    if (action === 'new') {
      if (!positional[2]) fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
      const root = await workspace();
      if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root.', 2);
      const change = await scaffold(root, positional[2], args.includes('--quick') ? 'quick' : 'standard');
      printWithSync(change, await syncIfAutomatic(root, change.id));
    } else if (action === 'list') {
      const root = await workspace();
      print({ workspace: root, changes: root ? await listChanges(root) : [] }, root ? undefined : 'No Notchlet workspace found.');
    } else if (action === 'show') {
      const root = await workspace();
      if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root or select one with --workspace.', 2);
      const id = positional[2];
      if (!id) fail('usage_error', usage, 'Provide a change ID from `notchlet change list`.', 64);
      const change = await readChange(root, id);
      const result = { change, readiness: readiness(change, await artifactContents(root, id, change)) };
      printWithSync(result, await syncIfAutomatic(root, id));
    } else if (action === 'convert') {
      const root = await workspace();
      if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root or select one with --workspace.', 2);
      const id = positional[2];
       const schema = optionValue('--schema');
       if (!id || (schema !== 'quick' && schema !== 'standard')) fail('usage_error', usage, 'Use `--schema quick` or `--schema standard`.', 64);
       const change = await persistConversion(root, id, schema);
       const result = { change, readiness: readiness(change, await artifactContents(root, id, change)) };
        printWithSync(result, await syncIfAutomatic(root, id));
    } else if (action === 'close') {
      const root = await workspace();
      if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` first.', 2);
      const id = positional[2];
      if (!id) fail('usage_error', usage, 'Provide a change ID.', 64);
      if (args.includes('--preview')) print(await previewCapabilityClose(root, id), 'Capability closure preview. No files were changed.');
      else {
        const revision = Number(optionValue('--baseline-revision'));
        if (!Number.isInteger(revision) || revision < 0) fail('usage_error', usage, 'Provide --baseline-revision from the capability preview.', 64);
        print(await closeChange(root, id, { expectedBaselineRevision: revision }), `Closed and archived ${id}.`);
      }
    } else fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
  } else if (command === 'task') {
    const root = await workspace();
    if (!root) fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root.', 2);
    const action = positional[1];
    let id: string | undefined, taskId: string | undefined, status: string | undefined, revisionText: string | undefined;
    if (action === 'start' || action === 'complete') {
      taskId = positional[2]; id = optionValue('--change'); status = action === 'start' ? 'in_progress' : 'completed'; revisionText = optionValue('--revision');
    } else if (action === 'update') {
      [, , id, taskId, status, revisionText] = positional;
    }
    if (!id || !taskId || !['pending', 'in_progress', 'completed'].includes(status ?? '') || !revisionText || !Number.isInteger(Number(revisionText))) fail('usage_error', usage, 'Use task start|complete <task-id> --change <id> --revision <n>, or task update <change> <task> <status> <revision>.', 64);
    const change = await transitionTask(path.join(root, '.notchlet', 'changes', id, 'tasks.json'), taskId, status as TaskStatus, Number(revisionText));
    printWithSync(change, await syncIfAutomatic(root, id));
  } else if (['status', 'validate', 'instructions'].includes(command)) {
    const root = await profileAsync('workspaceResolution', workspace);
    if (!root) {
      if (command === 'validate') fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root.', 2);
      print({ coreVersion: CORE_VERSION, workspace: null, changes: [] }, `No Notchlet workspace found. Core engine ${CORE_VERSION}.`);
    } else {
      const id = positional[1];
      if (!id) {
        if (command !== 'status') fail('usage_error', usage, `Provide a change ID for ${command}.`, 64);
        const changes = await listChanges(root);
        print({ protocolVersion: 1, coreVersion: CORE_VERSION, workspace: root, changes }, changes.length ? undefined : `No changes found. Core engine ${CORE_VERSION}.`);
      }
      else {
        if (positional.length !== 2) fail('usage_error', usage, 'Provide exactly one change ID.', 64);
        const change = await profileAsync('changeReadAndParse', () => readChange(root, id));
        const automaticSync = await profileAsync('automaticSyncModeCheck', () => syncIfAutomatic(root, id));
        const contents = await profileAsync('artifactReads', () => artifactContents(root, id, change));
        if (command === 'status') {
          const state = profileSync('evaluateState', () => evaluateState(change, undefined, contents));
          const derivedState = profileSync('deriveState', () => deriveStatus(evaluateState(change)));
          const readinessState = profileSync('readinessProjection', () => ({ ready: state.planning.status === 'ready', blockers: state.planning.blockers.map(({ source: _source, ...issue }) => issue) }));
          profileSync('serializeAndWrite', () => printWithSync({ protocolVersion: 1, coreVersion: CORE_VERSION, change: change.id, revision: change.revision ?? 0, state: derivedState, facets: state, readiness: readinessState }, automaticSync, `${change.name}: ${derivedState}\nCore engine: ${CORE_VERSION}\nEligible tasks: ${state.eligibleTasks.join(', ') || 'none'}\nBlockers: ${state.blockers.length}`));
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
          else printWithSync(result, automaticSync, result.ready ? 'Change is ready.' : `Change has ${result.blockers.length} readiness blocker(s).`);
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
    else console.error(`${code}: ${message}\nRecovery: ${recovery}`);
    process.exitCode = code === 'change_exists' ? 3 : 1;
  }
}
