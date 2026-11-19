import { readFile, writeFile, mkdir, lstat, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { inspectGitContext, parseChange, scaffold, readChange, type Change } from '@notchlet/core';
import { getProfile, resolveCredential, type AuthProfile, type CredentialStore } from './auth.js';

export type Fetcher = typeof fetch;
const positiveId = (n: number) => Number.isSafeInteger(n) && n > 0;
export function normalizeRemote(remote: { host: string; owner: string; repo: string }): string { return `${remote.host.toLowerCase()}/${remote.owner.toLowerCase()}/${remote.repo.replace(/\.git$/i, '').toLowerCase()}`; }

type IntegrationOptions = { server?: string; endpoint?: string; allowFileStore?: boolean; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore> };
type Capabilities = { server: { id: string; version: string }; protocol: { minimum: string; maximum: string }; versions: { core: string; schema: string }; operations: string[] };

const MAX_SYNC_BYTES = 1_048_576;
type SyncOptions = { server?: string; endpoint?: string; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore>; yes?: boolean; preview?: boolean; requiredOperations?: string[] };
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const syncDir = (root: string) => path.join(root, '.notchlet', '.local', 'sync');
async function syncState(root: string, id: string): Promise<any> {
  try { return JSON.parse(await readFile(path.join(syncDir(root), `${id}.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function saveSyncState(root: string, id: string, state: any): Promise<void> {
  const dir = syncDir(root); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.json`), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
const operationFile = (root: string, id: string, step: string) => path.join(syncDir(root), `${id}.${step}.operation.json`);
async function readPendingOperation(root: string, id: string, step: string) {
  try { return JSON.parse(await readFile(operationFile(root, id, step), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function pendingOperation(root: string, id: string, step: string, payloadHash: string, details: Record<string, unknown>) {
  const file = operationFile(root, id, step);
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.payloadHash !== payloadHash) throw Object.assign(new Error('A previous sync operation has an unresolved response for different local content. Reconcile it before changing this payload.'), { code: 'operation_payload_conflict' });
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const saved = { operationId: randomUUID(), payloadHash, ...details };
  await mkdir(syncDir(root), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return saved;
}
async function clearPendingOperation(root: string, id: string, step: string) { await rm(operationFile(root, id, step), { force: true }); }
async function reconcileOperation(ctx: Awaited<ReturnType<typeof syncContext>>, operationId: string, payloadHash: string) {
  const response = await remoteJson(ctx, `/operations/${operationId}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Could not reconcile the pending remote operation; it remains journaled for retry.');
  const operation = await response.json() as any;
  if (operation.operationId !== operationId || operation.payloadHash !== payloadHash) throw Object.assign(new Error('Remote operation identity or payload hash does not match the local journal.'), { code: 'operation_payload_conflict' });
  if (operation.state !== 'succeeded' || !operation.response) throw Object.assign(new Error('Remote operation is not yet complete; it remains journaled for retry.'), { code: 'operation_pending' });
  return operation.response;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function changePackage(root: string, id: string): Promise<{ payload: any; bytes: Buffer; hash: string }> {
  const change = await readChange(root, id);
  const artifacts: Record<string, string> = {};
  for (const relative of Object.values(change.artifacts)) {
    try { artifacts[relative] = await readFile(path.join(root, '.notchlet', 'changes', id, relative), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let evidence = '';
  try { evidence = await readFile(path.join(root, '.notchlet', 'changes', id, 'evidence.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const payload = { change, artifacts, evidence };
  const bytes = Buffer.from(canonical(payload));
  if (bytes.byteLength > MAX_SYNC_BYTES) throw Object.assign(new Error('Sync package exceeds the 1 MiB limit.'), { code: 'payload_too_large' });
  return { payload, bytes, hash: sha256(bytes) };
}

async function syncContext(root: string, options: SyncOptions) {
  const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
  const binding = workspace.binding;
  if (!binding) throw new Error('Workspace is not bound to a Development API product and repository.');
  const profile = await getProfile(options.server ?? binding.server);
  if (!profile || profile.origin !== binding.server) throw new Error('Selected CLI profile does not match the workspace server binding.');
  const { token } = await resolveCredential({ server: profile.origin, fetch: options.fetch, store: options.store, loadStore: options.loadStore });
  const base = options.endpoint ?? binding.server;
  const baseUrl = new URL(base);
  if (baseUrl.origin !== binding.server || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('Sync endpoint does not match the bound server origin.');
  const fetcher = options.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${token}`, 'X-Notchlet-Client-Version': '0.1.0' };
  const response = await fetcher(`${baseUrl.origin}/development/v1/capabilities`, { headers });
  if (response.status === 401) throw Object.assign(new Error('Server rejected the credential; authenticate again. Pending sync operations remain saved locally.'), { code: 'credential_revoked' });
  if (response.status === 403) throw Object.assign(new Error('Credential lacks the required workspace:read scope. Pending sync operations remain saved locally.'), { code: 'scope_insufficient' });
  if (!response.ok) throw new Error('Development API capabilities are unavailable.');
  const caps = await response.json() as any;
  if (caps.server?.id !== binding.serverIdentity) throw new Error('Development API server identity differs from workspace binding.');
  if (caps.protocol?.minimum !== binding.protocol?.minimum || caps.protocol?.maximum !== binding.protocol?.maximum || !caps.protocol?.minimum?.startsWith('1.') || Number(caps.protocol?.maximum?.split('.')[0]) < 1) throw new Error('Development API protocol differs from workspace binding or is incompatible.');
  const requiredOperations = ['createChange', 'uploadSnapshot', ...(options.requiredOperations ?? [])];
  if (caps.versions?.schema !== binding.schemaVersion || caps.versions?.core !== binding.coreVersion || caps.limits?.snapshotUploadBytes !== MAX_SYNC_BYTES || !Array.isArray(caps.operations) || !requiredOperations.every(op => caps.operations.includes(op))) throw new Error('Development API versions, limits, or required capabilities do not match the binding.');
  return { fetcher, headers, binding, base: `${baseUrl.origin}/development/v1` };
}

async function remoteJson(ctx: Awaited<ReturnType<typeof syncContext>>, route: string, init: RequestInit = {}) {
  return ctx.fetcher(`${ctx.base}${route}`, { ...init, headers: { ...ctx.headers, ...(init.headers ?? {}) } });
}

function safeRelative(relative: unknown): string {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) throw new Error('Remote snapshot contains an unsafe artifact path.');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Remote snapshot contains an unsafe artifact path.');
  return parts.join(path.sep);
}

async function lstatOrNull(file: string) {
  try { return await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function validateRemotePackage(id: string, remotePackage: any) {
  if (!remotePackage || typeof remotePackage !== 'object' || !remotePackage.change || !remotePackage.artifacts || typeof remotePackage.artifacts !== 'object' || typeof remotePackage.evidence !== 'string') throw new Error('Remote snapshot is not a valid sync package.');
  const remoteChange = parseChange(remotePackage.change);
  if (remoteChange.id !== id || !remoteChange.artifacts || Object.keys(remotePackage.artifacts).length !== Object.keys(remoteChange.artifacts).length) throw new Error('Remote package change identity or artifact declarations are invalid.');
  const files = new Map<string, string>();
  for (const [key, declared] of Object.entries(remoteChange.artifacts)) {
    const relative = safeRelative(declared);
    if (key !== declared || typeof remotePackage.artifacts[key] !== 'string') throw new Error('Remote package artifact contents do not match the declared artifact list.');
    files.set(relative, remotePackage.artifacts[key]);
  }
  files.set('evidence.jsonl', remotePackage.evidence);
  return { change: remoteChange, files };
}

async function reconcileRemotePackage(root: string, id: string, localPackage: any, remotePackage: any): Promise<void> {
  const { files } = validateRemotePackage(id, remotePackage);
  const changeDir = path.join(root, '.notchlet', 'changes', id);
  const transaction = path.join(changeDir, `.sync-stage-${randomUUID()}`), backup = path.join(transaction, '.backup');
  const installed: string[] = [], originals = new Map<string, Buffer | null>();
  await mkdir(path.join(transaction, 'new'), { recursive: true });
  try {
    // Validate all target paths and stage the complete package before touching a workspace file.
    for (const [relative, contents] of files) {
      const safe = safeRelative(relative), target = path.join(changeDir, safe);
      if (!target.startsWith(`${changeDir}${path.sep}`)) throw new Error('Remote snapshot path escapes the local change directory.');
      let parent = changeDir;
      for (const segment of path.dirname(safe).split(path.sep).filter(Boolean)) {
        parent = path.join(parent, segment);
        const stat = await lstatOrNull(parent);
        if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('Local artifact path traverses a non-directory or symlink.');
      }
      const existing = await lstatOrNull(target);
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('Local artifact target is not a regular file.');
      const priorContent = relative === 'evidence.jsonl' ? localPackage.evidence : localPackage.artifacts[relative.replace(/\\/g, '/')];
      if (existing) {
        const current = await readFile(target);
        if (typeof priorContent !== 'string' || !current.equals(Buffer.from(priorContent))) throw Object.assign(new Error('Local artifact changed since its recorded sync base.'), { code: 'local_file_conflict' });
        originals.set(safe, current);
      } else {
        if (typeof priorContent === 'string' && (relative !== 'evidence.jsonl' || priorContent.length > 0)) throw Object.assign(new Error('A previously synchronized local artifact is missing.'), { code: 'local_file_conflict' });
        originals.set(safe, null);
      }
      const stageTarget = path.join(transaction, 'new', safe);
      await mkdir(path.dirname(stageTarget), { recursive: true });
      await writeFile(stageTarget, contents, { flag: 'wx' });
    }
    for (const [relative] of files) {
      const safe = safeRelative(relative), target = path.join(changeDir, safe), stageTarget = path.join(transaction, 'new', safe);
      await mkdir(path.dirname(target), { recursive: true });
      const old = originals.get(safe);
      if (old !== null) {
        const backupFile = path.join(backup, safe); await mkdir(path.dirname(backupFile), { recursive: true });
        await rename(target, backupFile);
      }
      try { await rename(stageTarget, target); installed.push(safe); }
      catch (error) {
        if (old !== null) await rename(path.join(backup, safe), target);
        throw error;
      }
    }
  } catch (error) {
    for (const safe of installed.reverse()) {
      const target = path.join(changeDir, safe), old = originals.get(safe);
      await rm(target, { force: true });
      if (old !== null) await rename(path.join(backup, safe), target).catch(() => undefined);
    }
    throw error;
  } finally { await rm(transaction, { recursive: true, force: true }); }
}

export async function syncStatus(root: string, id: string, options: SyncOptions = {}) {
  const pkg = await changePackage(root, id), state = await syncState(root, id);
  if (!state) return { change: id, state: 'local-only', localHash: pkg.hash, remoteId: null };
  const ctx = await syncContext(root, options);
  const response = await remoteJson(ctx, `/changes/${state.remoteId}/snapshots`);
  if (!response.ok) throw new Error('Could not read remote snapshots.');
  const page = await response.json() as any;
  const latest = page.items?.sort((a: any, b: any) => b.revision - a.revision)[0];
  return { change: id, remoteId: state.remoteId, baseHash: state.baseHash, localHash: pkg.hash, remoteHash: latest?.sha256 ?? null, remoteCapturedAt: latest?.createdAt ?? null, state: !latest ? 'remote-empty' : latest.sha256 === pkg.hash ? 'unchanged' : pkg.hash === state.baseHash ? 'remote-only' : latest.sha256 === state.baseHash ? 'local-only' : 'divergent' };
}

export async function syncPush(root: string, id: string, options: SyncOptions = {}) {
  const pkg = await changePackage(root, id), local = await syncState(root, id), ctx = await syncContext(root, options);
  const hash = pkg.hash;
  let remoteId = local?.remoteId, revision = 0;
  if (remoteId) {
    const pendingCreate = await readPendingOperation(root, id, 'create');
    if (pendingCreate) {
      const created = await reconcileOperation(ctx, pendingCreate.operationId, pendingCreate.payloadHash);
      if (created && created.id !== remoteId) throw new Error('Pending create operation does not match the saved remote change binding.');
      await clearPendingOperation(root, id, 'create');
    }
    const existing = await remoteJson(ctx, `/changes/${remoteId}`);
    if (!existing.ok) throw new Error('Could not read remote change before push.');
    const metadata = await existing.json() as any; revision = metadata.revision;
    const snapshotsResponse = await remoteJson(ctx, `/changes/${remoteId}/snapshots`);
    if (!snapshotsResponse.ok) throw new Error('Could not read remote snapshots before push.');
    const snapshots = await snapshotsResponse.json() as any;
    const latest = snapshots.items?.sort((a: any, b: any) => b.revision - a.revision)[0];
    if (latest?.sha256 === hash) {
      const pending = await readPendingOperation(root, id, 'snapshot');
      if (pending) {
        const result = await reconcileOperation(ctx, pending.operationId, pending.payloadHash);
        if (result && (result.changeId !== remoteId || result.sha256 !== hash)) throw new Error('Pending snapshot operation result does not match the current remote snapshot.');
        await clearPendingOperation(root, id, 'snapshot');
      }
      await saveSyncState(root, id, { remoteId, baseRevision: metadata.revision, baseHash: hash, capturedAt: latest.createdAt ?? new Date().toISOString() });
      return { state: 'unchanged', remoteId, revision: metadata.revision, hash };
    }
    if (latest && latest.sha256 !== local?.baseHash) return { state: 'conflict', conflict: 'remote_revision_changed', nextAction: 'Run sync pull --change and resolve the conflict before pushing.' };
  }
  const preview = { change: id, remoteId: remoteId ?? null, expectedRevision: revision, payloadHash: hash, bytes: pkg.bytes.byteLength, willCreate: !remoteId };
  if (!options.yes && !options.preview) return { state: 'preview', preview, nextAction: 'Review this package and repeat with --yes to apply.' };
  if (!remoteId) {
    const body = { productId: ctx.binding.productId, title: pkg.payload.change.name, description: pkg.payload.change.description ?? '' };
    const bodyHash = sha256(canonical(body));
    const journal = await pendingOperation(root, id, 'create', bodyHash, { method: 'POST', path: '/changes', body, expectedRevision: 0 });
    let created = await reconcileOperation(ctx, journal.operationId, bodyHash);
    if (!created) {
      const response = await remoteJson(ctx, '/changes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': '"0"', 'Idempotency-Key': journal.operationId, 'X-Payload-SHA256': bodyHash }, body: canonical(body) });
      if (response.status === 409 || response.status === 412) { await clearPendingOperation(root, id, 'create'); throw Object.assign(new Error('Remote change creation conflicted; the local change is unchanged.'), { code: 'revision_conflict' }); }
      if (!response.ok) throw Object.assign(new Error('Remote change creation failed; its operation remains journaled for reconciliation.'), { code: 'remote_write_failed' });
      created = await response.json() as any;
    }
    remoteId = created.id; revision = created.revision;
    if (typeof remoteId !== 'string' || !Number.isSafeInteger(revision)) throw new Error('Reconciled remote change result is incomplete; operation remains journaled.');
    await saveSyncState(root, id, { remoteId, baseRevision: revision, baseHash: null });
    await clearPendingOperation(root, id, 'create');
  }
  const snapshotBody = { content: pkg.bytes.toString('base64'), contentType: 'application/json', sourceRevision: Number(pkg.payload.change.revision ?? 1), metadata: { localChangeId: id, payloadHash: hash } };
  const snapshotHash = sha256(canonical(snapshotBody));
  const journal = await pendingOperation(root, id, 'snapshot', snapshotHash, { method: 'POST', path: `/changes/${remoteId}/snapshots`, body: snapshotBody, expectedRevision: revision, remoteId });
  let snapshot = await reconcileOperation(ctx, journal.operationId, snapshotHash);
  if (!snapshot) {
    const upload = await remoteJson(ctx, `/changes/${remoteId}/snapshots`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': `"${revision}"`, 'Idempotency-Key': journal.operationId, 'X-Payload-SHA256': snapshotHash }, body: canonical(snapshotBody) });
    if (upload.status === 409 || upload.status === 412) { await clearPendingOperation(root, id, 'snapshot'); return { state: 'conflict', conflict: 'revision_conflict', nextAction: 'Run sync status and sync pull --change; the local change was not overwritten.' }; }
    if (!upload.ok) throw Object.assign(new Error('Remote snapshot upload failed; its operation remains journaled for reconciliation.'), { code: 'remote_write_failed' });
    snapshot = await upload.json() as any;
  }
  if (!snapshot || snapshot.changeId !== remoteId || snapshot.sha256 !== hash) throw new Error('Reconciled snapshot result does not match the pending local payload.');
  await saveSyncState(root, id, { remoteId, baseRevision: snapshot.changeRevision, baseHash: hash, capturedAt: snapshot.createdAt ?? new Date().toISOString() });
  await clearPendingOperation(root, id, 'snapshot');
  return { state: 'pushed', remoteId, revision: snapshot.changeRevision, hash };
}

export async function syncPull(root: string, id: string, options: SyncOptions = {}) {
  const local = await syncState(root, id);
  if (!local) return { state: 'conflict', conflict: 'unbound_local_change', nextAction: 'Push once to establish a remote binding; local files are unchanged.' };
  const pkg = await changePackage(root, id), ctx = await syncContext(root, options);
  const metadataResponse = await remoteJson(ctx, `/changes/${local.remoteId}`);
  if (!metadataResponse.ok) throw new Error('Could not read remote change.');
  const metadata = await metadataResponse.json() as any;
  const listResponse = await remoteJson(ctx, `/changes/${local.remoteId}/snapshots`);
  if (!listResponse.ok) throw new Error('Could not read remote snapshots.');
  const page = await listResponse.json() as any, latest = page.items?.sort((a: any, b: any) => b.revision - a.revision)[0];
  if (!latest || latest.sha256 === pkg.hash) return { state: 'unchanged', remoteId: local.remoteId, revision: metadata.revision };
  if (pkg.hash !== local.baseHash) return { state: 'conflict', conflict: 'divergent_edits', nextAction: 'Preserve local edits; compare the remote snapshot manually, then resolve before retrying.' };
  const contentResponse = await remoteJson(ctx, `/changes/${local.remoteId}/snapshots/${latest.id}`);
  if (!contentResponse.ok) throw new Error('Could not retrieve remote snapshot content.');
  const remote = await contentResponse.json() as any;
  const decoded = Buffer.from(remote.content, 'base64');
  if (decoded.byteLength > MAX_SYNC_BYTES || sha256(decoded) !== remote.sha256) throw new Error('Remote snapshot failed size or hash verification.');
  let parsed: any; try { parsed = JSON.parse(decoded.toString('utf8')); } catch { throw new Error('Remote snapshot is not a valid sync package.'); }
  await reconcileRemotePackage(root, id, pkg.payload, parsed);
  await saveSyncState(root, id, { remoteId: local.remoteId, baseRevision: metadata.revision, baseHash: latest.sha256, capturedAt: latest.createdAt ?? new Date().toISOString() });
  return { state: 'pulled', remoteId: local.remoteId, revision: metadata.revision, hash: latest.sha256 };
}

export async function syncResolve(root: string, id: string, strategy: 'keep-local', options: SyncOptions = {}) {
  const local = await syncState(root, id);
  if (!local?.remoteId) return { state: 'conflict', conflict: 'unbound_local_change', nextAction: 'Push once to establish a remote binding before resolving a conflict.' };
  if (typeof local.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(local.baseHash) || !Number.isSafeInteger(local.baseRevision) || local.baseRevision < 1) {
    return { state: 'conflict', conflict: 'missing_sync_base', nextAction: 'Fetch a verified base with sync pull or restore the local sync metadata; no remote write was attempted.' };
  }
  if (strategy !== 'keep-local') throw new Error('Conflict resolution requires the explicit keep-local strategy.');

  const pkg = await changePackage(root, id), ctx = await syncContext(root, options);
  const metadataResponse = await remoteJson(ctx, `/changes/${local.remoteId}`);
  if (!metadataResponse.ok) throw new Error('Could not read the current remote revision; conflict remains unresolved.');
  const metadata = await metadataResponse.json() as any;
  if (!Number.isSafeInteger(metadata.revision) || metadata.revision < 1) return { state: 'conflict', conflict: 'incompatible_remote_revision', nextAction: 'Refresh workspace capabilities and inspect the remote change before retrying.' };
  const listResponse = await remoteJson(ctx, `/changes/${local.remoteId}/snapshots`);
  if (!listResponse.ok) throw new Error('Could not read the current remote snapshot; conflict remains unresolved.');
  const page = await listResponse.json() as any;
  if (!Array.isArray(page.items)) return { state: 'conflict', conflict: 'incompatible_remote_snapshot', nextAction: 'Remote snapshot metadata is malformed; no local base was advanced and no write was attempted.' };
  const latest = page.items.slice().sort((a: any, b: any) => b.revision - a.revision)[0];
  if (!latest || latest.changeId !== local.remoteId || !Number.isSafeInteger(latest.revision) || latest.revision < 1 || !/^[a-f0-9]{64}$/.test(latest.sha256) || latest.revision !== metadata.snapshotRevision) {
    return { state: 'conflict', conflict: 'incompatible_remote_snapshot', nextAction: 'Remote snapshot metadata does not match the current change; no local base was advanced.' };
  }
  const contentResponse = await remoteJson(ctx, `/changes/${local.remoteId}/snapshots/${latest.id}`);
  if (!contentResponse.ok) throw new Error('Could not retrieve the current remote snapshot; conflict remains unresolved.');
  const remote = await contentResponse.json() as any;
  let decoded: Buffer;
  try { decoded = Buffer.from(remote.content, 'base64'); } catch { return { state: 'conflict', conflict: 'incompatible_remote_snapshot', nextAction: 'Remote snapshot content is malformed; no local base was advanced.' }; }
  if (decoded.byteLength > MAX_SYNC_BYTES || remote.id !== latest.id || remote.changeId !== local.remoteId || remote.revision !== latest.revision || remote.sha256 !== latest.sha256 || sha256(decoded) !== latest.sha256) {
    return { state: 'conflict', conflict: 'incompatible_remote_snapshot', nextAction: 'Remote snapshot failed identity, revision, size, or hash verification; no local base was advanced.' };
  }
  let remotePackage: any;
  try { remotePackage = JSON.parse(decoded.toString('utf8')); validateRemotePackage(id, remotePackage); }
  catch { return { state: 'conflict', conflict: 'incompatible_remote_snapshot', nextAction: 'Remote snapshot does not match this change schema or artifact identity; no local base was advanced.' }; }

  if (latest.sha256 === local.baseHash) {
    await saveSyncState(root, id, { ...local, baseRevision: metadata.revision, capturedAt: latest.createdAt ?? new Date().toISOString() });
    return { state: 'no_conflict', remoteId: local.remoteId, baseRevision: metadata.revision, localHash: pkg.hash, remoteHash: latest.sha256 };
  }
  if (latest.sha256 === pkg.hash) {
    await saveSyncState(root, id, { ...local, baseRevision: metadata.revision, baseHash: latest.sha256, capturedAt: latest.createdAt ?? new Date().toISOString() });
    return { state: 'already_synced', remoteId: local.remoteId, baseRevision: metadata.revision, hash: pkg.hash };
  }

  // The user explicitly chose the reconciled local package as the next desired state.
  // Advance only the verified base; the subsequent push still uses the current CAS revision.
  await saveSyncState(root, id, { ...local, baseRevision: metadata.revision, baseHash: latest.sha256, capturedAt: latest.createdAt ?? new Date().toISOString(), resolution: { strategy, localHash: pkg.hash, remoteHash: latest.sha256, remoteRevision: metadata.revision, resolvedAt: new Date().toISOString() } });
  return { state: 'resolved', strategy, remoteId: local.remoteId, baseRevision: metadata.revision, localHash: pkg.hash, remoteHash: latest.sha256, nextAction: 'Review the local artifacts, then run sync push --yes to retry conditionally against this remote revision.' };
}

export async function syncCheckpoint(root: string, id: string, input: { name: string; summary?: string; backlogStatus?: 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' }, options: SyncOptions = {}) {
  if (!input.name.trim() || input.name.length > 100 || (input.summary !== undefined && input.summary.length > 4096)) throw new Error('Checkpoint name or summary does not match the supported schema.');
  const local = await syncState(root, id);
  if (!local?.remoteId) throw new Error('Change must be synchronized before creating a remote checkpoint.');
  const ctx = await syncContext(root, { ...options, requiredOperations: ['checkpoint'] });
  const metadataResponse = await remoteJson(ctx, `/changes/${local.remoteId}`);
  if (!metadataResponse.ok) throw new Error('Could not read remote change before checkpoint.');
  const metadata = await metadataResponse.json() as any;
  if (!Number.isSafeInteger(metadata.snapshotRevision) || metadata.snapshotRevision < 1) throw new Error('A synchronized snapshot is required before checkpointing.');
  const body = { name: input.name, snapshotRevision: metadata.snapshotRevision, ...(input.summary === undefined ? {} : { summary: input.summary }), ...(input.backlogStatus === undefined ? {} : { backlogStatus: input.backlogStatus }) };
  const bodyHash = sha256(canonical(body));
  const journal = await pendingOperation(root, id, 'checkpoint', bodyHash, { method: 'POST', path: `/changes/${local.remoteId}/checkpoints`, body, expectedRevision: metadata.revision, remoteId: local.remoteId });
  let result = await reconcileOperation(ctx, journal.operationId, bodyHash);
  if (!result) {
    const response = await remoteJson(ctx, `/changes/${local.remoteId}/checkpoints`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': `"${journal.expectedRevision}"`, 'Idempotency-Key': journal.operationId, 'X-Payload-SHA256': bodyHash }, body: canonical(body) });
    if (response.status === 409 || response.status === 412) { await clearPendingOperation(root, id, 'checkpoint'); return { state: 'conflict', conflict: 'revision_conflict', nextAction: 'Refresh remote change state and create a new checkpoint after reviewing the revision.' }; }
    if (!response.ok) throw Object.assign(new Error('Remote checkpoint failed; its operation remains journaled for reconciliation.'), { code: 'remote_write_failed' });
    result = await response.json() as any;
  }
  if (!result || result.changeId !== local.remoteId || result.name !== body.name || result.snapshotRevision !== body.snapshotRevision) throw new Error('Reconciled checkpoint result does not match the pending operation.');
  await clearPendingOperation(root, id, 'checkpoint');
  return { state: 'checkpointed', remoteId: local.remoteId, checkpoint: result };
}

async function discoverCapabilities(profile: AuthProfile, options: IntegrationOptions = {}): Promise<{ capabilities: Capabilities; diagnostic: string }> {
  const { token } = await resolveCredential({ server: profile.origin, allowFileStore: options.allowFileStore, fetch: options.fetch, store: options.store, loadStore: options.loadStore });
  const response = await (options.fetch ?? fetch)(`${profile.origin}/development/v1/capabilities`, { headers: { Authorization: `Bearer ${token}`, 'X-Notchlet-Client-Version': '0.1.0' } });
  if (response.status === 401) throw Object.assign(new Error('Server rejected the credential; authenticate again.'), { diagnostic: 'credential_revoked' });
  if (response.status === 403) throw Object.assign(new Error('Credential lacks the required workspace:read scope.'), { diagnostic: 'scope_insufficient' });
  if (response.status === 404) throw Object.assign(new Error('Capabilities endpoint was not found. The server deployment may be missing the Development API route; update/redeploy the backend and ensure DEVELOPMENT_API_ENABLED is not set to false.'), { diagnostic: 'endpoint_not_found' });
  if (!response.ok) throw Object.assign(new Error(`Capabilities endpoint is unavailable (HTTP ${response.status}).`), { diagnostic: 'server_unavailable' });
  const capabilities = await response.json() as Capabilities;
  const version = (v: string) => v.split('.').map((x: string) => Number(x));
  const compare = (a: number[], b: number[]) => (a[0] - b[0]) || ((a[1] ?? 0) - (b[1] ?? 0));
  const min = version(capabilities.protocol?.minimum ?? '0.0'), max = version(capabilities.protocol?.maximum ?? '0.0'), client = [1, 0];
  if (!capabilities.server?.id || !capabilities.server.version || !capabilities.versions?.core || !capabilities.versions?.schema) throw Object.assign(new Error('Capabilities response is incomplete.'), { diagnostic: 'backend_version_mismatch' });
  if (compare(min, client) > 0 || compare(max, client) < 0) return { capabilities, diagnostic: 'protocol_mismatch' };
  if (capabilities.versions.schema !== '1.0.0' || capabilities.server.version !== capabilities.versions.core) return { capabilities, diagnostic: 'backend_version_mismatch' };
  return { capabilities, diagnostic: 'ok' };
}

function accessibleProducts(context: any): any[] {
  const organizations = Array.isArray(context) ? context : context?.organizations ?? [];
  return organizations.flatMap((org: any) => org.teams ?? []).flatMap((team: any) => team.products ?? []);
}

const resultValue = (response: any) => {
  const text = response.content?.find((part: any) => part.type === 'text')?.text;
  if (text) { try { return JSON.parse(text); } catch { return text; } }
  return response.structuredContent ?? response;
};

function normalizedRepoRemote(repo: any): string | null {
  if (!repo || typeof repo.repoOwner !== 'string' || typeof repo.repoName !== 'string') return null;
  let host = '';
  if (typeof repo.serverUrl === 'string' && repo.serverUrl) {
    try { host = new URL(repo.serverUrl).hostname.toLowerCase(); } catch { return null; }
  } else {
    const provider = String(repo.provider ?? '').toLowerCase();
    host = provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : provider === 'bitbucket' ? 'bitbucket.org' : '';
  }
  if (!host) return null;
  return normalizeRemote({ host, owner: repo.repoOwner, repo: repo.repoName });
}

async function verifyProductRepository(input: { productId: number; repositoryId: number; profile: AuthProfile; endpoint?: string; fetch?: Fetcher; allowFileStore?: boolean; store?: CredentialStore; loadStore?: () => Promise<CredentialStore> }): Promise<{ product: any; repository: any; repositoryRemote: string }> {
  if (input.profile.authMode !== 'user') {
    const options = { server: input.profile.origin, endpoint: input.endpoint, fetch: input.fetch, allowFileStore: input.allowFileStore, store: input.store, loadStore: input.loadStore };
    const context = resultValue(await callMcpTool('workspace_context', {}, options)) as any;
    if (!accessibleProducts(context).some((p: any) => Number(p.id) === input.productId)) throw Object.assign(new Error('Selected product is not accessible in workspace_context.'), { diagnostic: 'product_access_denied' });
    const product = resultValue(await callMcpTool('product_get_details', { productId: input.productId }, options)) as any;
    if (Number(product?.id ?? product?.product?.id) !== input.productId) throw Object.assign(new Error('Selected product identity did not match the requested numeric ID.'), { diagnostic: 'product_access_denied' });
    const response = resultValue(await callMcpTool('backlog_list', { productId: input.productId }, options)) as any;
    const items = Array.isArray(response) ? response : Array.isArray(response?.items) ? response.items : [];
    const carrier = items.find((candidate: any) => Number(candidate.productId ?? candidate.product?.id) === input.productId && positiveId(Number(candidate.id)));
    if (!carrier) throw Object.assign(new Error('No accessible backlog item is available to inspect this product repository list.'), { diagnostic: 'repository_unavailable' });
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const repositoryPage = resultValue(await callMcpTool('backlog_development_context', { itemId: Number(carrier.id), section: 'repositories', limit: 20, ...(cursor ? { cursor } : {}) }, options)) as any;
      const repositories = repositoryPage?.items ?? repositoryPage?.git?.repositories?.items ?? [];
      const selected = repositories.find((repo: any) => Number(repo.id) === input.repositoryId);
      if (selected) {
        const repositoryRemote = normalizedRepoRemote(selected);
        if (!repositoryRemote) throw Object.assign(new Error('Selected repository has no normalizable remote identity.'), { diagnostic: 'repository_mismatch' });
        return { product, repository: selected, repositoryRemote };
      }
      const next = repositoryPage?.nextCursor ?? repositoryPage?.git?.repositories?.nextCursor;
      if (typeof next !== 'string' || !next) break;
      if (seen.has(next)) throw Object.assign(new Error('Repository list returned a repeated cursor.'), { diagnostic: 'repository_mismatch' });
      seen.add(next); cursor = next;
    }
    throw Object.assign(new Error('Selected repository ID is not connected to the selected product.'), { diagnostic: 'repository_mismatch' });
  }
  const api = await platformApi(input.profile.origin, { fetch: input.fetch, allowFileStore: input.allowFileStore, store: input.store, loadStore: input.loadStore });
  const product = await api.get(`/products/${input.productId}`);
  if (Number(product?.id) !== input.productId) throw Object.assign(new Error('Selected product identity did not match the requested numeric ID.'), { diagnostic: 'product_access_denied' });
  const config = await api.get(`/git/config?productId=${input.productId}`);
  const repositories = Array.isArray(config) ? config : config ? [config] : [];
  const selected = repositories.find((repo: any) => Number(repo.id) === input.repositoryId);
  if (!selected) throw Object.assign(new Error('Selected repository ID is not connected to the selected product.'), { diagnostic: 'repository_mismatch' });
  const repositoryRemote = normalizedRepoRemote(selected);
  if (!repositoryRemote) throw Object.assign(new Error('Selected repository has no normalizable remote identity.'), { diagnostic: 'repository_mismatch' });
  return { product, repository: selected, repositoryRemote };
}

export async function bindWorkspace(root: string, input: { server: string; productId: number; repositoryId: number; endpoint?: string; rebind?: boolean; allowFileStore?: boolean; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore> }) {
  if (!positiveId(input.productId) || !positiveId(input.repositoryId)) throw new Error('Product and repository IDs must be positive integers.');
  const profile = await getProfile(input.server);
  if (!profile) throw new Error('No profile exists for the selected server; authenticate first.');
  if (input.endpoint) endpointFor(profile, input.endpoint);
  const { capabilities } = await discoverCapabilities(profile, input);
  const verified = await verifyProductRepository({ ...input, profile });
  const git = await inspectGitContext(root);
  if (!git.available || !git.isRepository) throw new Error('Workspace binding requires a Git checkout.');
  const localRemotes = git.repository.remotes.map(normalizeRemote);
  const matchingRemote = localRemotes.includes(verified.repositoryRemote);
  if (!matchingRemote) throw Object.assign(new Error('Selected product repository remote does not match this Git checkout.'), { diagnostic: 'repository_mismatch' });
  const file = path.join(root, '.notchlet', 'workspace.json');
  const old = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const binding = { serverIdentity: capabilities.server.id, server: profile.origin, endpoint: input.endpoint, protocol: capabilities.protocol, coreVersion: capabilities.versions.core, schemaVersion: capabilities.versions.schema, productId: input.productId, repositoryId: input.repositoryId, repositoryRemote: verified.repositoryRemote, gitRoot: git.repository.topLevel };
  const prior = old.binding as typeof binding | undefined;
  const fields: (keyof typeof binding)[] = ['serverIdentity', 'server', 'productId', 'repositoryId', 'repositoryRemote', 'gitRoot'];
  if (prior && !input.rebind && fields.some(field => prior[field] !== binding[field])) throw new Error('Workspace binding differs from the current server or checkout; pass --rebind to confirm.');
  if (prior && !input.rebind && (prior.coreVersion !== binding.coreVersion || prior.schemaVersion !== binding.schemaVersion || JSON.stringify(prior.protocol) !== JSON.stringify(binding.protocol))) throw new Error('Server capability versions changed; pass --rebind to confirm the updated binding.');
  if (prior && !input.rebind && prior.endpoint !== binding.endpoint) throw new Error('Workspace MCP endpoint changed; pass --rebind to confirm.');
  if (prior && !input.rebind && fields.every(field => prior[field] === binding[field]) && prior.coreVersion === binding.coreVersion && prior.schemaVersion === binding.schemaVersion && JSON.stringify(prior.protocol) === JSON.stringify(binding.protocol) && prior.endpoint === binding.endpoint) return { binding: prior, rebound: false, alreadyBound: true };
  old.binding = binding;
  await writeFile(file, `${JSON.stringify(old, null, 2)}\n`);
  return { binding, rebound: Boolean(prior && input.rebind) };
}

function endpointFor(profile: AuthProfile, override?: string): URL {
  const raw = override ?? `${profile.origin}/mcp`;
  const url = new URL(raw, profile.origin);
  if ((url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') || url.username || url.password || url.search || url.hash) throw new Error('MCP endpoint must use HTTPS (HTTP is allowed only on localhost) and contain no credentials, query, or fragment.');
  return url;
}

export type PlatformApi = { origin: string; token: string; fetcher: Fetcher; get(route: string, init?: RequestInit): Promise<any> };
export async function platformApi(server?: string, options: { allowFileStore?: boolean; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore> } = {}): Promise<PlatformApi> {
  const { profile, token } = await resolveCredential({ server, allowFileStore: options.allowFileStore, fetch: options.fetch, store: options.store, loadStore: options.loadStore });
  const fetcher = options.fetch ?? fetch;
  return {
    origin: profile.origin,
    token,
    fetcher,
    async get(route, init = {}) {
      const response = await fetcher(`${profile.origin}${route}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
      if (response.status === 401) throw new Error('Notchlet rejected the login session. Run `notchlet auth login` again.');
      if (response.status === 403) throw new Error('This account does not have access to the selected Notchlet resource.');
      if (!response.ok) throw new Error(`Notchlet API request failed with HTTP ${response.status}.`);
      return response.status === 204 ? undefined : response.json();
    },
  };
}

export async function setWorkspaceSyncMode(root: string, mode: 'manual' | 'auto') {
  const file = path.join(root, '.notchlet', 'workspace.json');
  const workspace = JSON.parse(await readFile(file, 'utf8'));
  workspace.preferences = { ...(workspace.preferences ?? {}), syncMode: mode };
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, file);
  return { syncMode: mode };
}

export async function getWorkspaceSyncMode(root: string): Promise<'manual' | 'auto'> {
  try {
    const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    return workspace.preferences?.syncMode === 'auto' ? 'auto' : 'manual';
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'manual'; throw error; }
}

/** Best-effort reconciliation in auto mode; pulls are guarded and divergent edits remain explicit. */
export async function autoSyncChange(root: string, id: string, options: SyncOptions = {}) {
  if (await getWorkspaceSyncMode(root) !== 'auto') return { state: 'manual', change: id };
  try {
    const status = await syncStatus(root, id, options);
    if (status.state === 'unchanged') return { state: 'unchanged', change: id, remoteId: status.remoteId };
    if (status.state === 'remote-only') return { ...(await syncPull(root, id, options)), automatic: true };
    if (status.state === 'divergent') return { state: 'conflict', change: id, conflict: 'divergent_edits', nextAction: 'Local and remote edits differ from the shared base. Run sync status and resolve explicitly.' };
    return { ...(await syncPush(root, id, { ...options, yes: true })), automatic: true };
  }
  catch (error) {
    return { state: 'pending', change: id, message: error instanceof Error ? error.message : 'Sync unavailable; local work remains saved.' };
  }
}

export async function callMcpTool<T = unknown>(toolName: string, args: Record<string, unknown>, options: { server?: string; endpoint?: string; allowFileStore?: boolean; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore> } = {}): Promise<T> {
  const { profile, token } = await resolveCredential(options);
  const transport = new StreamableHTTPClientTransport(endpointFor(profile, options.endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const client = new Client({ name: 'notchlet-cli', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some(tool => tool.name === toolName)) throw new Error(`MCP server does not advertise required tool: ${toolName}`);
    const result = await client.callTool({ name: toolName, arguments: args });
    if (result.isError) throw new Error(`MCP tool ${toolName} failed.`);
    return result as T;
  } catch (error) {
    const status = (error as { code?: number }).code;
    if (status === 401 || status === 403) throw new Error(status === 401 ? 'Server rejected the credential; authenticate again.' : 'Credential lacks the required workspace:read scope.');
    throw error;
  } finally { await client.close().catch(() => undefined); }
}

export async function doctor(root: string | null, options: { server?: string; endpoint?: string; allowFileStore?: boolean; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore> } = {}) {
  const git = await inspectGitContext(root ?? process.cwd());
  const profile = await getProfile(options.server);
  if (!profile) return { online: false, profile: null, git, binding: null, diagnostic: 'no_profile' };
  let capabilities: Capabilities | null = null, online = false, diagnostic = 'offline';
  try {
    const discovered = await discoverCapabilities(profile, options);
    capabilities = discovered.capabilities; online = true; diagnostic = discovered.diagnostic;
  } catch (error) {
    diagnostic = (error as { diagnostic?: string }).diagnostic ?? 'offline';
  }
  let binding: unknown = null;
  if (root) try { binding = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8')).binding ?? null; } catch { /* uninitialized local workspace */ }
  if (online && binding && capabilities) {
    const bound = binding as any;
    if (bound.serverIdentity !== capabilities.server.id || bound.server !== profile.origin) diagnostic = 'server_identity_mismatch';
    else if (JSON.stringify(bound.protocol) !== JSON.stringify(capabilities.protocol)) diagnostic = 'protocol_mismatch';
    else if (bound.coreVersion !== capabilities.versions.core || bound.schemaVersion !== capabilities.versions.schema) diagnostic = 'backend_version_mismatch';
    try {
      if (diagnostic !== 'ok') throw Object.assign(new Error('Capability identity or version mismatch.'), { diagnostic });
      const profileForBinding = { ...profile, origin: bound.server };
      const verified = await verifyProductRepository({ productId: Number(bound.productId), repositoryId: Number(bound.repositoryId), profile: profileForBinding, endpoint: options.endpoint ?? bound.endpoint, allowFileStore: options.allowFileStore, fetch: options.fetch, store: options.store, loadStore: options.loadStore });
      const currentRemote = git.available && git.isRepository ? git.repository.remotes.map(normalizeRemote).includes(verified.repositoryRemote) : false;
      if (!currentRemote || bound.repositoryRemote !== verified.repositoryRemote || bound.gitRoot !== (git.available && git.isRepository ? git.repository.topLevel : null)) diagnostic = 'repository_mismatch';
    } catch (error) {
      const code = (error as { diagnostic?: string }).diagnostic;
      if (code) diagnostic = code;
      else if (diagnostic === 'ok') diagnostic = 'product_access_denied';
    }
  }
  const authScopes = !online ? [] : profile.authMode === 'user' ? ['workspace:read', 'changes:write', 'backlog:write'] : ['workspace:read'];
  return { online, profile: { origin: profile.origin, serverIdentity: profile.serverIdentity, authMode: profile.authMode ?? 'token' }, capabilities, authScopes, git, binding, diagnostic };
}

export async function importBacklogItem(root: string, input: { productId: number; itemId: number; server?: string; endpoint?: string; allowFileStore?: boolean; fetch?: Fetcher; store?: CredentialStore; loadStore?: () => Promise<CredentialStore> }): Promise<Change> {
  if (!positiveId(input.productId) || !positiveId(input.itemId)) throw new Error('Product and backlog item IDs must be positive integers.');
  const selectedProfile = await getProfile(input.server);
  const useMcp = selectedProfile?.authMode !== 'user';
  const api = useMcp ? null : await platformApi(input.server, input);
  const legacyCall = (name: string, args: Record<string, unknown>) => callMcpTool(name, args, input);
  const item = api
    ? await api.get(`/backlog/${input.itemId}`)
    : resultValue(await legacyCall('backlog_get', { itemId: input.itemId }));
  if (Number(item?.id) !== input.itemId || Number(item?.productId) !== input.productId) throw new Error('Selected backlog item does not belong to the selected product.');
  const contextPages: unknown[] = [], seenCursors = new Set<string>();
  let cursor: string | undefined, contextTruncated = false;
  for (let page = 0; page < 3; page++) {
    const query = new URLSearchParams({ section: 'item', limit: '20', ...(cursor ? { cursor } : {}) });
    const contextPage = api
      ? await api.get(`/backlog/${input.itemId}/development-context?${query.toString()}`)
      : resultValue(await legacyCall('backlog_development_context', { itemId: input.itemId, section: 'item', limit: 20, ...(cursor ? { cursor } : {}) }));
    const candidate = [...contextPages, contextPage];
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 32_768) throw new Error('Backlog development context exceeds the 32 KiB import limit.');
    contextPages.push(contextPage);
    const next = contextPage?.nextCursor ?? contextPage?.pagination?.nextCursor;
    if (typeof next !== 'string' || !next) break;
    if (seenCursors.has(next)) throw new Error('Backlog development context returned a repeated cursor.');
    if (page === 2) { contextTruncated = true; break; }
    seenCursors.add(next); cursor = next;
  }
  const description = String(item.description ?? item.item?.description ?? '');
  const title = String(item.title ?? item.item?.title ?? `Backlog item ${input.itemId}`);
  const id = `backlog-${input.itemId}`;
  const markerDir = path.join(root, '.notchlet', 'imports'); await mkdir(markerDir, { recursive: true });
  const marker = path.join(markerDir, `${input.itemId}.json`);
  try { await readFile(marker, 'utf8'); throw new Error(`Backlog item ${input.itemId} is already linked to a local change.`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  // Scaffold is create-only; a pre-existing change is never replaced.
  const change = await scaffold(root, `Backlog item ${input.itemId}: ${title}`, 'quick');
  const proposal = `# ${title}\n\n## Imported backlog description\n\n${description}\n\n## Bounded development context\n\n${JSON.stringify({ pages: contextPages, truncated: contextTruncated }, null, 2)}\n`;
  await writeFile(path.join(root, '.notchlet', 'changes', change.id, 'proposal.md'), proposal);
  const tasksFile = path.join(root, '.notchlet', 'changes', change.id, 'tasks.json');
  const imported = parseChange(await readFile(tasksFile, 'utf8'));
  const requirementId = `REQ-ITEM-${input.itemId}`;
  const criteria = item.acceptanceCriteria ?? item.acceptanceCriteriaText ?? item.item?.acceptanceCriteria;
  const checkDescriptions: string[] = Array.isArray(criteria) ? criteria.filter((v: unknown) => typeof v === 'string' && v.trim()) : typeof criteria === 'string' && criteria.trim() ? [criteria] : [];
  const next: Change = { ...imported, requirements: [{ id: requirementId, title, description: description || title }], checks: (checkDescriptions.length ? checkDescriptions : [`Verify the requirements and acceptance criteria for backlog item ${input.itemId}.`]).map((text, index) => ({ id: `CHECK-ITEM-${input.itemId}-${index + 1}`, description: text })), tasks: [{ id: `TASK-ITEM-${input.itemId}`, title: `Implement backlog item ${input.itemId}`, status: 'pending', dependencies: [], requirementIds: [requirementId] }] };
  await writeFile(tasksFile, `${JSON.stringify(next, null, 2)}\n`);
  await writeFile(marker, `${JSON.stringify({ server: (await getProfile(input.server))?.serverIdentity, productId: input.productId, itemId: input.itemId, changeId: change.id }, null, 2)}\n`, { flag: 'wx' });
  return next;
}
