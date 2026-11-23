import { createHash } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteJson,
  buildNode,
  changeRefHash,
  composeNodeDirectory,
  emptyBacklogSidecar,
  flattenTree,
  mapLocalToRemoteStatus,
  parseChange,
  readBacklogSidecar,
  resolveChangeLocation,
  scaffoldNode,
  scanChangeDirectories,
  stableId,
  withBaselines,
  withLinkedItem,
  withObservedPlatform,
  withPlanning,
  writeBacklogSidecar,
  WorkflowError,
  type BacklogItemType,
  type BacklogPlanningDetails,
  type BacklogPriorityLevel,
  type BacklogRemoteStatus,
  type BacklogSidecar,
  type BacklogSyncDetails,
  type Change,
  type ChangeTreeNode,
} from '@notchlet/core';
import {
  callMcpTool,
  platformApi,
  syncCheckpoint,
  syncDeliver,
  syncPull,
  syncPush,
  syncStatus,
  type Fetcher,
  type SyncOptions,
} from './integration.js';
import { getProfile } from './auth.js';

export interface BacklogTreeOptions extends SyncOptions {
  productId?: number;
  includeChildren?: boolean;
  includeAncestors?: boolean;
  maxItems?: number;
  mode?: 'quick' | 'standard';
  dryRun?: boolean;
  importNew?: boolean;
  allowFileStore?: boolean;
}

interface RemoteBacklogItem {
  id: number;
  productId?: number;
  parentId?: number | null;
  itemType: BacklogItemType;
  title: string;
  key?: string | null;
  status?: string;
  description?: string;
  descriptionRevision?: number;
  priorityLevel?: string | null;
  storyPoints?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  updatedAt?: string;
  acceptanceCriteria?: unknown;
}

interface RemotePage { items: RemoteBacklogItem[]; nextCursor?: string | null }

interface BacklogClient {
  item(id: number): Promise<RemoteBacklogItem>;
  ancestors(id: number): Promise<RemoteBacklogItem[]>;
  children(id: number, cursor?: string): Promise<RemotePage>;
  list(productId: number): Promise<RemoteBacklogItem[]>;
  create(input: { productId: number; parentId?: number; itemType: BacklogItemType; title: string; description: string; priorityLevel?: BacklogPriorityLevel; storyPoints?: number; startDate?: string; dueDate?: string }): Promise<RemoteBacklogItem>;
  update(id: number, patch: Record<string, unknown>): Promise<RemoteBacklogItem>;
}

const ITEM_TYPES: BacklogItemType[] = ['EPIC', 'STORY', 'TASK', 'SUBTASK'];
const REMOTE_STATUSES: BacklogRemoteStatus[] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
const MAX_IMPORT_ITEMS = 200;

function itemValue(value: unknown): RemoteBacklogItem {
  const candidate = (value as any)?.item ?? value;
  if (!candidate || typeof candidate !== 'object' || !Number.isSafeInteger(Number(candidate.id))) throw new WorkflowError('invalid_backlog_item', 'Backlog item response is missing a numeric identity.', 'Refresh the backlog item and retry.');
  const itemType = String(candidate.itemType ?? '').toUpperCase() as BacklogItemType;
  if (!ITEM_TYPES.includes(itemType)) throw new WorkflowError('invalid_node_type', `Backlog item ${candidate.id} has unsupported type ${candidate.itemType}.`, 'Only EPIC, STORY, TASK, and SUBTASK import into a local tree.');
  return { ...candidate, id: Number(candidate.id), itemType, title: String(candidate.title ?? `Backlog item ${candidate.id}`) };
}

function pageValue(value: unknown): RemotePage {
  const page = (value as any) ?? {};
  const items = Array.isArray(page) ? page : Array.isArray(page.items) ? page.items : [];
  return { items: items.map(itemValue), nextCursor: typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null };
}

function resultValue(response: any): any {
  const text = response?.content?.find((part: any) => part.type === 'text')?.text;
  if (text) { try { return JSON.parse(text); } catch { return text; } }
  return response?.structuredContent ?? response;
}

function restClient(api: Awaited<ReturnType<typeof platformApi>>): BacklogClient {
  const contextPage = async (id: number, section: 'ancestors' | 'children', cursor?: string) => {
    const query = new URLSearchParams({ section, limit: section === 'children' ? '50' : '20', ...(cursor ? { cursor } : {}) });
    return api.get(`/backlog/${id}/development-context?${query.toString()}`);
  };
  return {
    async item(id) { return itemValue(await api.get(`/backlog/${id}`)); },
    async ancestors(id) {
      const items: RemoteBacklogItem[] = [], seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 3; page++) {
        const response = await contextPage(id, 'ancestors', cursor);
        items.push(...pageValue(response).items);
        const next = response?.nextCursor;
        if (typeof next !== 'string' || !next || seen.has(next)) break;
        seen.add(next); cursor = next;
      }
      return items;
    },
    async children(id, cursor) { return pageValue(await contextPage(id, 'children', cursor)); },
    async list(productId) {
      const response = await api.get(`/backlog?productId=${productId}`);
      return (Array.isArray(response) ? response : response?.items ?? []).map(itemValue);
    },
    async create(input) { return itemValue(await api.post('/backlog', input)); },
    async update(id, patch) { return itemValue(await api.patch(`/backlog/${id}`, patch)); },
  };
}

function mcpClient(options: BacklogTreeOptions): BacklogClient {
  const call = async (name: string, args: Record<string, unknown>) => resultValue(await callMcpTool(name, args, options));
  return {
    async item(id) { return itemValue(await call('backlog_get', { itemId: id })); },
    async ancestors(id) {
      const items: RemoteBacklogItem[] = [], seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 3; page++) {
        const response = await call('backlog_development_context', { itemId: id, section: 'ancestors', limit: 20, ...(cursor ? { cursor } : {}) });
        items.push(...pageValue(response).items);
        const next = response?.nextCursor ?? response?.pagination?.nextCursor;
        if (typeof next !== 'string' || !next || seen.has(next)) break;
        seen.add(next); cursor = next;
      }
      return items;
    },
    async children(id, cursor) {
      return pageValue(await call('backlog_development_context', { itemId: id, section: 'children', limit: 50, ...(cursor ? { cursor } : {}) }));
    },
    async list(productId) {
      const response = await call('backlog_list', { productId });
      return (Array.isArray(response) ? response : response?.items ?? []).map(itemValue);
    },
    async create(input) { return itemValue(await call('backlog_create', input)); },
    async update(id, patch) { return itemValue(await call('backlog_update', { itemId: id, ...patch })); },
  };
}

async function clientFor(options: BacklogTreeOptions): Promise<BacklogClient> {
  const profile = await getProfile(options.server);
  if (profile?.authMode === 'user') return restClient(await platformApi(options.server, options));
  return mcpClient(options);
}

function acceptanceCriteria(item: RemoteBacklogItem): string[] {
  const raw = item.acceptanceCriteria;
  if (Array.isArray(raw)) return raw.filter((value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()));
  return typeof raw === 'string' && raw.trim() ? [raw] : [];
}

function checksFor(item: RemoteBacklogItem): Change['checks'] {
  const criteria = acceptanceCriteria(item);
  const descriptions = criteria.length ? criteria : [`Verify the requirements and acceptance criteria for backlog item ${item.id}.`];
  return descriptions.map((description, index) => ({ id: `CHECK-ITEM-${item.id}-${index + 1}`, description }));
}

interface ImportedNode { itemId: number; itemType: BacklogItemType; relativePath: string; action: 'created' | 'reused' | 'legacy'; }
export interface BacklogTreeImportResult {
  productId: number;
  rootItemId: number;
  imported: ImportedNode[];
  skipped: Array<{ itemId: number; reason: string; relativePath?: string }>;
  nodes: Array<{ relativePath: string; itemId: number; itemType: BacklogItemType }>;
  truncated: boolean;
  dryRun: boolean;
}

interface LocalIndex { byItem: Map<number, string>; byLegacy: Map<number, string> }

async function localIndex(root: string): Promise<LocalIndex> {
  const byItem = new Map<number, string>(), byLegacy = new Map<number, string>();
  for (const entry of await scanChangeDirectories(root, { scope: 'merged' })) {
    const sidecar = await readBacklogSidecar(entry.directory);
    if (sidecar?.platform.itemId !== undefined) byItem.set(sidecar.platform.itemId, entry.relativePath);
  }
  try {
    for (const entry of await readdir(path.join(root, '.notchlet', 'imports'))) {
      if (!entry.endsWith('.json')) continue;
      try {
        const marker = JSON.parse(await readFile(path.join(root, '.notchlet', 'imports', entry), 'utf8'));
        const itemId = Number(marker?.itemId), changeId = String(marker?.changeId ?? '');
        if (Number.isSafeInteger(itemId) && itemId > 0 && changeId && !byLegacy.has(itemId)) byLegacy.set(itemId, changeId);
      } catch { /* skip unreadable legacy markers */ }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { byItem, byLegacy };
}

async function writeImportMarker(root: string, input: { server?: string; productId: number; itemId: number; change: Change; relativePath: string }): Promise<void> {
  const directory = path.join(root, '.notchlet', 'imports');
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path.join(directory, `${input.itemId}.json`), `${JSON.stringify({ server: input.server ?? null, productId: input.productId, itemId: input.itemId, changeId: input.change.id, relativePath: input.relativePath }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

function authorImportedChange(change: Change, item: RemoteBacklogItem, leaf: boolean): Change {
  const requirementId = `REQ-ITEM-${item.id}`;
  const description = item.description?.trim() || item.title;
  const requirements = change.requirements.some(requirement => requirement.id === requirementId)
    ? change.requirements
    : [...change.requirements, { id: requirementId, title: item.title, description }];
  const checks = change.checks.length ? change.checks : checksFor(item);
  const tasks = leaf && change.tasks.length === 0
    ? [{ id: `TASK-ITEM-${item.id}`, title: `Implement backlog item ${item.id}`, status: 'pending' as const, dependencies: [], requirementIds: [requirementId] }]
    : change.tasks;
  return { ...change, intent: change.intent || item.description?.trim() || item.title, requirements, checks, tasks };
}

async function persistSidecar(directory: string, sidecar: BacklogSidecar): Promise<void> {
  await writeBacklogSidecar(directory, { ...sidecar, meta: { ...sidecar.meta, updatedAt: new Date().toISOString() } });
}

/**
 * Import a platform backlog subtree into the local tree, creating ancestor shells so the hierarchy
 * matches the platform. Re-import is idempotent by backlog item ID and never fabricates evidence.
 */
export async function importBacklogTree(root: string, input: BacklogTreeOptions & { productId: number; itemId: number }): Promise<BacklogTreeImportResult> {
  const maxItems = Math.min(Math.max(input.maxItems ?? MAX_IMPORT_ITEMS, 1), MAX_IMPORT_ITEMS);
  const client = await clientFor(input);
  const target = await client.item(input.itemId);
  if (target.productId !== undefined && Number(target.productId) !== input.productId) throw new WorkflowError('backlog_item_not_found', 'Selected backlog item does not belong to the selected product.', 'Check the product ID or select the item again.');
  const rootItem = target;
  const index = await localIndex(root);
  const imported: ImportedNode[] = [], skipped: BacklogTreeImportResult['skipped'] = [], nodes: BacklogTreeImportResult['nodes'] = [];
  let truncated = false, visited = 0;

  const visit = async (item: RemoteBacklogItem, parentPath: string | undefined, ancestry: RemoteBacklogItem[], leafKnown?: boolean): Promise<string | undefined> => {
    if (visited >= maxItems) { truncated = true; return undefined; }
    visited += 1;
    const existing = index.byItem.get(item.id);
    if (existing) {
      const location = await resolveChangeLocation(root, existing, { scope: 'merged' });
      if (!input.dryRun) {
        const sidecar = await readBacklogSidecar(location.directory);
        if (sidecar) {
          await persistSidecar(location.directory, withObservedPlatform(sidecar, {
            key: item.key ?? undefined,
            parentItemId: item.parentId ?? null,
            remoteStatus: REMOTE_STATUSES.includes(item.status as BacklogRemoteStatus) ? item.status as BacklogRemoteStatus : undefined,
            remoteUpdatedAt: item.updatedAt,
          }, 'import'));
        } else {
          const created = emptyBacklogSidecar({ itemType: item.itemType, title: item.title, origin: 'import', productId: String(input.productId), lastWriter: 'import' });
          await persistSidecar(location.directory, withLinkedItem({ ...created, node: { ...created.node, origin: 'import' } }, {
            productId: String(input.productId), itemId: item.id, key: item.key ?? undefined, parentItemId: item.parentId ?? null,
            remoteStatus: REMOTE_STATUSES.includes(item.status as BacklogRemoteStatus) ? item.status as BacklogRemoteStatus : undefined,
            remoteUpdatedAt: item.updatedAt,
          }, 'import'));
        }
      }
      imported.push({ itemId: item.id, itemType: item.itemType, relativePath: location.relativePath, action: 'reused' });
      nodes.push({ relativePath: location.relativePath, itemId: item.id, itemType: item.itemType });
      if (leafKnown !== false) {
        const children = await fetchChildren(item.id);
        for (const child of children) await visit(child, location.relativePath, [...ancestry, item]);
      }
      return location.relativePath;
    }
    const legacyChangeId = index.byLegacy.get(item.id);
    if (legacyChangeId) {
      try {
        const location = await resolveChangeLocation(root, legacyChangeId, { scope: 'merged' });
        const change = parseChange(await readFile(path.join(location.directory, 'tasks.json'), 'utf8'));
        if (!input.dryRun) {
          const sidecar = await readBacklogSidecar(location.directory) ?? emptyBacklogSidecar({ itemType: item.itemType, title: item.title, origin: 'import', productId: String(input.productId), lastWriter: 'import' });
          await persistSidecar(location.directory, withLinkedItem(sidecar, {
            productId: String(input.productId), itemId: item.id, key: item.key ?? undefined, parentItemId: item.parentId ?? null,
            remoteStatus: REMOTE_STATUSES.includes(item.status as BacklogRemoteStatus) ? item.status as BacklogRemoteStatus : undefined,
            remoteUpdatedAt: item.updatedAt,
          }, 'import'));
          await writeImportMarker(root, { server: input.server, productId: input.productId, itemId: item.id, change, relativePath: location.relativePath });
        }
        index.byItem.set(item.id, location.relativePath);
        imported.push({ itemId: item.id, itemType: item.itemType, relativePath: location.relativePath, action: 'legacy' });
        nodes.push({ relativePath: location.relativePath, itemId: item.id, itemType: item.itemType });
        return location.relativePath;
      } catch { /* a broken legacy marker falls through to a fresh scaffold */ }
    }

    const slug = item.key ? `${item.key.toLowerCase()}-${stableId(item.title)}` : stableId(item.title);
    const children = leafKnown === false ? [] : await fetchChildren(item.id);
    if (input.dryRun) {
      const relativePath = composeNodeDirectory({ slug, ...(parentPath === undefined ? {} : { parentRelativePath: parentPath }) });
      index.byItem.set(item.id, relativePath);
      nodes.push({ relativePath, itemId: item.id, itemType: item.itemType });
      imported.push({ itemId: item.id, itemType: item.itemType, relativePath, action: 'created' });
      for (const child of children) await visit(child, relativePath, [...ancestry, item]);
      return relativePath;
    }
    const scaffolded = await scaffoldNode(root, {
      name: item.title,
      title: item.title,
      slug,
      itemType: item.itemType,
      ...(parentPath === undefined ? {} : { parent: parentPath }),
      mode: input.mode ?? 'quick',
      productId: String(input.productId),
      lastWriter: 'import',
    });
    const linked = withLinkedItem({ ...scaffolded.backlog, node: { ...scaffolded.backlog.node, origin: 'import' } }, {
      productId: String(input.productId), itemId: item.id, key: item.key ?? undefined, parentItemId: item.parentId ?? null,
      remoteStatus: REMOTE_STATUSES.includes(item.status as BacklogRemoteStatus) ? item.status as BacklogRemoteStatus : undefined,
      remoteUpdatedAt: item.updatedAt,
    }, 'import');
    await persistSidecar(scaffolded.directory, linked);
    const change = authorImportedChange(parseChange(await readFile(path.join(scaffolded.directory, 'tasks.json'), 'utf8')), item, leafKnown === false ? false : children.length === 0);
    await atomicWriteJson(path.join(scaffolded.directory, 'tasks.json'), change);
    const proposal = `# ${item.title}\n\n## Imported backlog description\n\n${item.description ?? ''}\n\n## Platform identity\n\n- Item: ${item.id}${item.key ? ` (${item.key})` : ''}\n- Type: ${item.itemType}\n- Parent: ${item.parentId ?? '(none)'}\n${ancestry.length ? `\n## Ancestors\n\n${ancestry.map(ancestor => `- ${ancestor.itemType} ${ancestor.id}: ${ancestor.title}`).join('\n')}\n` : ''}`;
    await writeFile(path.join(scaffolded.directory, 'proposal.md'), proposal);
    await writeImportMarker(root, { server: input.server, productId: input.productId, itemId: item.id, change, relativePath: scaffolded.relativePath });
    index.byItem.set(item.id, scaffolded.relativePath);
    imported.push({ itemId: item.id, itemType: item.itemType, relativePath: scaffolded.relativePath, action: 'created' });
    nodes.push({ relativePath: scaffolded.relativePath, itemId: item.id, itemType: item.itemType });
    for (const child of children) await visit(child, scaffolded.relativePath, [...ancestry, item]);
    return scaffolded.relativePath;
  };

  const fetchChildren = async (id: number): Promise<RemoteBacklogItem[]> => {
    if (input.includeChildren === false) return [];
    const items: RemoteBacklogItem[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await client.children(id, cursor);
      items.push(...response.items);
      if (!response.nextCursor) break;
      if (seen.has(response.nextCursor)) throw new WorkflowError('import_cursor_repeated', 'Backlog children pagination returned a repeated cursor.', 'Retry the import; the platform page state changed.');
      seen.add(response.nextCursor); cursor = response.nextCursor;
    }
    return items;
  };

  let parentPath: string | undefined;
  if (input.includeAncestors !== false) {
    const ancestors = (await client.ancestors(input.itemId)).reverse();
    for (const ancestor of ancestors) parentPath = await visit(ancestor, parentPath, [], false);
  }
  await visit(rootItem, parentPath, []);
  return { productId: input.productId, rootItemId: input.itemId, imported, skipped, nodes, truncated, dryRun: Boolean(input.dryRun) };
}

async function workspaceProductId(root: string): Promise<number | undefined> {
  try {
    const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    const productId = Number(workspace.binding?.productId);
    return Number.isSafeInteger(productId) && productId > 0 ? productId : undefined;
  } catch { return undefined; }
}

async function readWorkspacePreferences(root: string): Promise<{ syncMode: string; pushTaskStatus: boolean }> {
  try {
    const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    return { syncMode: workspace.preferences?.syncMode === 'auto' ? 'auto' : 'manual', pushTaskStatus: workspace.preferences?.pushTaskStatus === true };
  } catch { return { syncMode: 'manual', pushTaskStatus: false }; }
}

function syncKeyFor(sidecar: BacklogSidecar | null, relativePath: string): string {
  return sidecar?.platform.itemId !== undefined ? `item-${sidecar.platform.itemId}` : `local-${changeRefHash(relativePath)}`;
}

async function migrateSyncState(root: string, fromKey: string, toKey: string): Promise<void> {
  const directory = path.join(root, '.notchlet', '.local', 'sync');
  const from = path.join(directory, `${fromKey}.json`), to = path.join(directory, `${toKey}.json`);
  try { await rename(from, to); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

function descriptionFor(change: Change): string {
  return (change.outcome || change.intent || change.name).slice(0, 4000);
}

interface EnsuredItem { itemId: number; key?: string; relativePath: string; sidecar: BacklogSidecar; created: boolean; warnings: string[] }

type PlanningField = 'priorityLevel' | 'storyPoints' | 'startDate' | 'dueDate';
const PLANNING_FIELDS: Array<{ field: PlanningField; baseline: keyof BacklogSyncDetails }> = [
  { field: 'priorityLevel', baseline: 'lastPushedPriorityLevel' },
  { field: 'storyPoints', baseline: 'lastPushedStoryPoints' },
  { field: 'startDate', baseline: 'lastPushedStartDate' },
  { field: 'dueDate', baseline: 'lastPushedDueDate' },
];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function remotePlanning(item: RemoteBacklogItem): BacklogPlanningDetails {
  return {
    ...(typeof item.priorityLevel === 'string' && ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(item.priorityLevel) ? { priorityLevel: item.priorityLevel as BacklogPriorityLevel } : {}),
    ...(item.storyPoints === undefined || item.storyPoints === null || !Number.isFinite(Number(item.storyPoints)) ? {} : { storyPoints: Number(item.storyPoints) }),
    ...(typeof item.startDate === 'string' && item.startDate ? { startDate: item.startDate } : {}),
    ...(typeof item.dueDate === 'string' && item.dueDate ? { dueDate: item.dueDate } : {}),
  };
}

function equalPlanning(field: PlanningField, left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (field === 'startDate' || field === 'dueDate') return Date.parse(String(left)) === Date.parse(String(right));
  if (field === 'storyPoints') return Number(left) === Number(right);
  return String(left) === String(right);
}

interface ReconcileResult {
  title: string;
  observations: Parameters<typeof withObservedPlatform>[1];
  planning: BacklogPlanningDetails;
  baselines: Partial<BacklogSyncDetails>;
  updateBody: Record<string, unknown>;
  warnings: string[];
}

/**
 * Three-way reconcile of platform fields against the last pushed baseline. Remote-only edits are adopted,
 * local-only edits are pushed, and differently edited fields are reported and skipped rather than overwritten.
 */
function reconcilePlanning(sidecar: BacklogSidecar, item: RemoteBacklogItem): ReconcileResult {
  const observations: ReconcileResult['observations'] = {
    key: item.key ?? undefined,
    parentItemId: item.parentId ?? null,
    remoteStatus: REMOTE_STATUSES.includes(item.status as BacklogRemoteStatus) ? item.status as BacklogRemoteStatus : undefined,
    remoteUpdatedAt: item.updatedAt,
    remoteTitle: item.title,
  };
  const planning: BacklogPlanningDetails = {};
  const baselines: Partial<BacklogSyncDetails> = {};
  const updateBody: Record<string, unknown> = {};
  const warnings: string[] = [];
  let title = sidecar.node.title;

  const baseTitle = sidecar.sync.lastPushedTitle;
  if (baseTitle === item.title) {
    if (sidecar.node.title !== baseTitle) { updateBody.title = sidecar.node.title; baselines.lastPushedTitle = sidecar.node.title; }
  } else if (baseTitle === undefined) {
    if (sidecar.node.title === item.title) baselines.lastPushedTitle = item.title;
    else warnings.push(`Title diverged: local "${sidecar.node.title}", remote "${item.title}".`);
  } else if (sidecar.node.title === baseTitle) {
    title = item.title;
    baselines.lastPushedTitle = item.title;
    warnings.push(`Remote title "${item.title}" replaced "${baseTitle}".`);
  } else if (sidecar.node.title === item.title) {
    baselines.lastPushedTitle = item.title;
  } else {
    warnings.push(`Title diverged: local "${sidecar.node.title}", remote "${item.title}".`);
  }

  const remoteDescription = typeof item.description === 'string' ? item.description : undefined;
  const remoteDescriptionHash = remoteDescription === undefined ? undefined : digest(remoteDescription);
  observations.remoteDescriptionSha256 = remoteDescriptionHash;
  observations.descriptionRevision = Number.isSafeInteger(item.descriptionRevision) && Number(item.descriptionRevision) >= 0 ? Number(item.descriptionRevision) : undefined;
  if (remoteDescription !== undefined) {
    if (sidecar.planning?.description === undefined) {
      baselines.lastPushedDescriptionSha256 = remoteDescriptionHash;
    } else {
      const localDescription = sidecar.planning.description;
      const localHash = digest(localDescription);
      const baseHash = sidecar.sync.lastPushedDescriptionSha256;
      if (baseHash === remoteDescriptionHash) {
        if (localHash !== baseHash) {
          updateBody.description = localDescription;
          if (observations.descriptionRevision !== undefined) updateBody.expectedDescriptionRevision = observations.descriptionRevision;
          baselines.lastPushedDescriptionSha256 = localHash;
        }
      } else if (baseHash === undefined || localHash === baseHash) {
        planning.description = remoteDescription;
        baselines.lastPushedDescriptionSha256 = remoteDescriptionHash;
        warnings.push('Remote description was adopted; local authored plan text changed on the platform.');
      } else if (localHash === remoteDescriptionHash) {
        baselines.lastPushedDescriptionSha256 = remoteDescriptionHash;
      } else {
        warnings.push('Description diverged: the local authored description and the platform description changed independently.');
      }
    }
  }

  const remote = remotePlanning(item);
  for (const { field, baseline } of PLANNING_FIELDS) {
    const local = sidecar.planning?.[field];
    const remoteValue = remote[field];
    const base = sidecar.sync[baseline] as typeof local;
    if (remoteValue === undefined) {
      if (local !== undefined && !equalPlanning(field, local, base)) {
        updateBody[field] = local;
        (baselines as Record<string, unknown>)[baseline] = local;
      }
      continue;
    }
    if (base === undefined) {
      if (local === undefined) {
        (planning as Record<string, unknown>)[field] = remoteValue;
        (baselines as Record<string, unknown>)[baseline] = remoteValue;
      } else if (equalPlanning(field, local, remoteValue)) {
        (baselines as Record<string, unknown>)[baseline] = remoteValue;
      } else {
        updateBody[field] = local;
        (baselines as Record<string, unknown>)[baseline] = local;
      }
      continue;
    }
    if (equalPlanning(field, base, remoteValue)) {
      if (!equalPlanning(field, local, base) && local !== undefined) {
        updateBody[field] = local;
        (baselines as Record<string, unknown>)[baseline] = local;
      }
    } else if (local === undefined || equalPlanning(field, local, base)) {
      (planning as Record<string, unknown>)[field] = remoteValue;
      (baselines as Record<string, unknown>)[baseline] = remoteValue;
      warnings.push(`${field} changed on the platform and was adopted (${String(remoteValue)}).`);
    } else if (equalPlanning(field, local, remoteValue)) {
      (baselines as Record<string, unknown>)[baseline] = remoteValue;
    } else {
      warnings.push(`${field} diverged: local ${String(local)}, remote ${String(remoteValue)}; the field was skipped.`);
    }
  }

  for (const key of ['priorityLevel', 'storyPoints', 'startDate', 'dueDate'] as PlanningField[]) {
    if (remote[key] !== undefined) (observations as Record<string, unknown>)[key] = remote[key];
  }
  return { title, observations, planning, baselines, updateBody, warnings };
}

function matchesUpdate(body: Record<string, unknown>, item: RemoteBacklogItem): boolean {
  for (const [key, value] of Object.entries(body)) {
    if (key === 'expectedDescriptionRevision') continue;
    const remote = (item as unknown as Record<string, unknown>)[key];
    if (key === 'startDate' || key === 'dueDate') {
      if (remote === undefined || remote === null || Date.parse(String(remote)) !== Date.parse(String(value))) return false;
    } else if (key === 'storyPoints') {
      if (Number(remote) !== Number(value)) return false;
    } else if (remote !== value) return false;
  }
  return true;
}

interface ResolvedBacklogItem {
  relativePath: string;
  productId: number;
  sidecar: BacklogSidecar;
  itemId?: number;
  parentItemId?: number | null;
  key?: string;
  remote?: RemoteBacklogItem;
  createBody?: { productId: number; parentId?: number; itemType: BacklogItemType; title: string; description: string; priorityLevel?: BacklogPriorityLevel; storyPoints?: number; startDate?: string; dueDate?: string };
  updateBody: Record<string, unknown>;
  baselines: Partial<BacklogSyncDetails>;
  planning: BacklogPlanningDetails;
  observations: Parameters<typeof withObservedPlatform>[1];
  warnings: string[];
}

async function resolveBacklogItem(root: string, node: ChangeTreeNode, parentItemId: number | undefined, client: BacklogClient, input: BacklogTreeOptions): Promise<ResolvedBacklogItem> {
  if (!node.backlog) throw new WorkflowError('missing_backlog_sidecar', `${node.relativePath} has no backlog.json sidecar, so it cannot create a platform backlog item.`, 'Create the node with `notchlet change new <name> --as <type>` or import it from the platform.');
  const sidecarProduct = Number(node.backlog.platform.productId);
  const productId = input.productId ?? (Number.isSafeInteger(sidecarProduct) && sidecarProduct > 0 ? sidecarProduct : undefined) ?? await workspaceProductId(root);
  if (productId === undefined || !Number.isSafeInteger(productId) || productId < 1) throw new WorkflowError('product_required', 'No product is selected for this backlog node.', 'Bind the workspace or pass --product-id.');

  let remote: RemoteBacklogItem | undefined;
  if (node.backlog.platform.itemId !== undefined) {
    remote = await client.item(node.backlog.platform.itemId);
  } else {
    const matches = (await client.list(productId)).filter(item => item.itemType === node.backlog!.node.itemType && item.title === node.backlog!.node.title && (item.parentId ?? null) === (parentItemId ?? null));
    if (matches.length > 1) throw new WorkflowError('ambiguous_duplicate', `${matches.length} backlog items match ${node.backlog.node.itemType} "${node.backlog.node.title}" under the same parent.`, 'Rename the duplicates on the platform or link the intended item, then retry.');
    remote = matches[0];
  }

  if (!remote) {
    const description = (node.backlog.planning?.description ?? descriptionFor(node.change)).slice(0, 4000);
    const createBody = {
      productId,
      ...(parentItemId === undefined ? {} : { parentId: parentItemId }),
      itemType: node.backlog.node.itemType,
      title: node.backlog.node.title,
      description,
      ...(node.backlog.planning?.priorityLevel === undefined ? {} : { priorityLevel: node.backlog.planning.priorityLevel }),
      ...(node.backlog.planning?.storyPoints === undefined ? {} : { storyPoints: node.backlog.planning.storyPoints }),
      ...(node.backlog.planning?.startDate === undefined ? {} : { startDate: node.backlog.planning.startDate }),
      ...(node.backlog.planning?.dueDate === undefined ? {} : { dueDate: node.backlog.planning.dueDate }),
    };
    return {
      relativePath: node.relativePath, productId, sidecar: node.backlog, createBody,
      updateBody: {}, planning: {}, observations: {},
      baselines: {
        lastPushedTitle: createBody.title,
        lastPushedDescriptionSha256: digest(description),
        ...(createBody.priorityLevel === undefined ? {} : { lastPushedPriorityLevel: createBody.priorityLevel }),
        ...(createBody.storyPoints === undefined ? {} : { lastPushedStoryPoints: createBody.storyPoints }),
        ...(createBody.startDate === undefined ? {} : { lastPushedStartDate: createBody.startDate }),
        ...(createBody.dueDate === undefined ? {} : { lastPushedDueDate: createBody.dueDate }),
      },
      warnings: [],
    };
  }

  const reconciled = reconcilePlanning(node.backlog, remote);
  const observed = withObservedPlatform(node.backlog, reconciled.observations, 'sync');
  const sidecar = { ...observed, node: { ...observed.node, title: reconciled.title } };
  return {
    relativePath: node.relativePath, productId, sidecar, itemId: remote.id, parentItemId: sidecar.platform.parentItemId ?? null, ...(remote.key ? { key: remote.key } : {}), remote,
    updateBody: reconciled.updateBody, planning: reconciled.planning, baselines: reconciled.baselines, observations: reconciled.observations,
    warnings: reconciled.warnings,
  };
}

async function applyBacklogItem(root: string, node: ChangeTreeNode, resolved: ResolvedBacklogItem, client: BacklogClient, input: BacklogTreeOptions): Promise<EnsuredItem> {
  const warnings = [...resolved.warnings];
  const syncDirectory = path.join(root, '.notchlet', '.local', 'sync');
  let remote = resolved.remote;
  let created = false;
  let updateFailed = false;
  const createJournal = path.join(syncDirectory, `${syncKeyFor(node.backlog, node.relativePath)}.backlog-create.operation.json`);
  const updateJournal = path.join(syncDirectory, `${syncKeyFor(node.backlog, node.relativePath)}.backlog-update.operation.json`);

  if (resolved.createBody) {
    const body = resolved.createBody;
    const payloadHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await mkdir(syncDirectory, { recursive: true });
    await writeFile(createJournal, `${JSON.stringify({ operationId: createHash('sha256').update(`${node.relativePath}:${payloadHash}`).digest('hex').slice(0, 32), payloadHash, body, createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'w' });
    // Create is not idempotent upstream; re-list after any uncertain response before retrying.
    const findCreated = async () => {
      const items = await client.list(resolved.productId).catch(() => [] as RemoteBacklogItem[]);
      return items.find(item => item.itemType === body.itemType && item.title === body.title && (item.parentId ?? null) === (body.parentId ?? null));
    };
    remote = await findCreated();
    if (!remote) {
      try { remote = await client.create(body); }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Backlog item creation failed.';
        try { remote = await findCreated(); } catch { /* keep the original failure */ }
        if (!remote) throw new WorkflowError('remote_write_failed', `Could not create the backlog item for ${node.relativePath}: ${message}`, 'Retry `notchlet sync push --tree`; a matching item is adopted instead of duplicated.');
      }
    }
    created = true;
  } else if (resolved.itemId !== undefined && Object.keys(resolved.updateBody).length) {
    const body = resolved.updateBody;
    const payloadHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await mkdir(syncDirectory, { recursive: true });
    await writeFile(updateJournal, `${JSON.stringify({ operationId: createHash('sha256').update(`${resolved.itemId}:${payloadHash}`).digest('hex').slice(0, 32), payloadHash, itemId: resolved.itemId, body, createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'w' });
    try { remote = await client.update(resolved.itemId, body); }
    catch (error) {
      const status = (error as { status?: number }).status;
      const confirmed = await client.item(resolved.itemId).catch(() => undefined);
      if (confirmed && matchesUpdate(body, confirmed)) remote = confirmed;
      else if (status === 409 || status === 412) { updateFailed = true; warnings.push('The platform description changed concurrently; the description was not overwritten.'); }
      else throw new WorkflowError('remote_write_failed', `Could not update backlog item ${resolved.itemId}: ${error instanceof Error ? error.message : 'remote write failed'}`, 'Retry `notchlet sync push --tree`; the update is journaled and will be reconciled.');
    }
    await rm(updateJournal, { force: true }).catch(() => undefined);
  }
  if (!remote) throw new WorkflowError('remote_write_failed', `Backlog item ${resolved.itemId ?? '(new)'} could not be resolved after apply.`, 'Retry `notchlet sync push --tree`.');

  // Baselines must reflect what actually reached the platform; claiming a divergent or failed field as pushed
  // would let the next run overwrite the platform silently.
  const remoteValues = remotePlanning(remote);
  const baselines: Record<string, unknown> = { ...resolved.baselines };
  if (created) {
    baselines.lastPushedTitle = remote.title;
    if (typeof remote.description === 'string') baselines.lastPushedDescriptionSha256 = digest(remote.description);
    for (const { field, baseline } of PLANNING_FIELDS) if (remoteValues[field] !== undefined) baselines[baseline] = remoteValues[field];
  } else if (updateFailed && typeof remote.description === 'string') {
    baselines.lastPushedDescriptionSha256 = digest(remote.description);
  }

  const linked = withLinkedItem(resolved.sidecar, {
    productId: String(resolved.productId),
    itemId: remote.id,
    key: remote.key ?? undefined,
    parentItemId: remote.parentId === undefined ? (resolved.parentItemId ?? null) : remote.parentId,
    remoteStatus: REMOTE_STATUSES.includes(remote.status as BacklogRemoteStatus) ? remote.status as BacklogRemoteStatus : undefined,
    remoteUpdatedAt: remote.updatedAt,
    remoteTitle: remote.title,
    remoteDescriptionSha256: typeof remote.description === 'string' ? digest(remote.description) : undefined,
    descriptionRevision: Number.isSafeInteger(remote.descriptionRevision) ? Number(remote.descriptionRevision) : undefined,
    ...remoteValues,
  }, 'sync');
  const planned = Object.keys(resolved.planning).length ? withPlanning(linked, resolved.planning, 'sync') : linked;
  const sidecar = withBaselines(planned, baselines as Partial<BacklogSyncDetails>, 'sync');
  const location = await resolveChangeLocation(root, node.relativePath, { scope: 'active' });
  await migrateSyncState(root, syncKeyFor(node.backlog, node.relativePath), `item-${remote.id}`);
  await persistSidecar(location.directory, sidecar);
  const relativePath = await renameKeyFirst(root, node, sidecar, remote.key ?? undefined);
  await writeImportMarker(root, { server: input.server, productId: resolved.productId, itemId: remote.id, change: node.change, relativePath });
  await rm(createJournal, { force: true }).catch(() => undefined);
  return { itemId: remote.id, ...(remote.key ? { key: remote.key } : {}), relativePath, sidecar, created, warnings };
}

/** Key-first folder naming applies only to leaves that have never been pushed, so linked history stays stable. */
async function renameKeyFirst(root: string, node: ChangeTreeNode, sidecar: BacklogSidecar, key: string | undefined): Promise<string> {
  if (!key || node.children.length) return node.relativePath;
  const parent = node.relativePath.split('/').slice(0, -1).join('/');
  // Imported nodes already carry the platform key inside their slug; prefixing again would duplicate it.
  const prefixed = sidecar.node.slug.startsWith(`${key.toLowerCase()}-`);
  const desired = composeNodeDirectory({ ...(prefixed ? {} : { key }), slug: sidecar.node.slug, ...(parent ? { parentRelativePath: parent } : {}) });
  if (desired === node.relativePath) return node.relativePath;
  try { await resolveChangeLocation(root, desired, { scope: 'active' }); return node.relativePath; }
  catch { /* destination is free */ }
  const from = (await resolveChangeLocation(root, node.relativePath, { scope: 'active' })).directory;
  const to = path.join(root, '.notchlet', 'changes', ...desired.split('/'));
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  return desired;
}

function ancestorsOf(node: ChangeTreeNode): string[] {
  const segments = node.relativePath.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

export interface TreeSyncNodeResult {
  relativePath: string;
  itemId?: number;
  key?: string;
  state: string;
  remoteId?: string;
  conflict?: string;
  error?: string;
  remoteOnlyChildren?: number[];
  warnings?: string[];
  preview?: unknown;
}

export interface TreeSyncResult {
  action: 'status' | 'push' | 'pull';
  nodes: TreeSyncNodeResult[];
  remoteOnly: Array<{ parentItemId: number; itemIds: number[] }>;
  stopped: boolean;
  warnings?: string[];
  imported?: Array<{ parentItemId: number; itemId: number; dryRun: boolean; nodes: number; truncated: boolean }>;
}

/**
 * Sync a local subtree. Push walks ancestors then pre-order so parents exist before children;
 * pull applies snapshots and refreshes only observed platform fields.
 */
export async function syncTree(root: string, reference: string, action: 'status' | 'push' | 'pull', options: BacklogTreeOptions = {}): Promise<TreeSyncResult> {
  const target = await buildNode(root, reference);
  const ancestors: ChangeTreeNode[] = [];
  for (const relativePath of ancestorsOf(target)) ancestors.push(await buildNode(root, relativePath));
  const nodes = [...ancestors, ...flattenTree(target)];
  const productId = options.productId ?? await workspaceProductId(root);
  const needsClient = action !== 'status' && nodes.some(node => node.backlog);
  const client = needsClient ? await clientFor({ ...options, ...(productId === undefined ? {} : { productId }) }) : null;
  const itemIds = new Map<string, number>();
  for (const node of ancestors) {
    if (node.backlog?.platform.itemId !== undefined) itemIds.set(node.relativePath, node.backlog.platform.itemId);
  }
  const results: TreeSyncNodeResult[] = [];
  const remoteOnly: TreeSyncResult['remoteOnly'] = [];
  const warnings: string[] = [];
  const preferences = await readWorkspacePreferences(root);
  const preview = !options.yes;
  let stopped = false, conflictSeen = false;

  for (const node of nodes) {
    if (stopped) break;
    const parentPath = node.relativePath.split('/').slice(0, -1).join('/');
    const parentItemId = parentPath ? itemIds.get(parentPath) : undefined;
    try {
      if (action === 'push' && node.backlog) {
        if (!client) throw new Error('No backlog client is available.');
        if (!preview && parentPath && parentItemId === undefined) throw new WorkflowError('parent_not_on_platform', `Parent ${parentPath} is not yet linked to a platform backlog item.`, 'Push the parent first, or run `notchlet sync push --tree` from the tree root.');
        const resolved = await resolveBacklogItem(root, node, parentItemId, client, { ...options, ...(productId === undefined ? {} : { productId }) });
        warnings.push(...resolved.warnings);
        if (preview) {
          if (resolved.itemId !== undefined) { itemIds.set(node.relativePath, resolved.itemId); itemIds.set(resolved.relativePath, resolved.itemId); }
          const pushed = await syncPush(root, resolved.relativePath, { ...options });
          results.push({
            relativePath: resolved.relativePath, ...(resolved.itemId === undefined ? {} : { itemId: resolved.itemId }), ...(resolved.key === undefined ? {} : { key: resolved.key }),
            state: pushed.state, ...(pushed.preview === undefined ? {} : { preview: pushed.preview }), ...(resolved.warnings.length ? { warnings: resolved.warnings } : {}),
          });
          if (pushed.state === 'conflict') { stopped = true; conflictSeen = true; }
          continue;
        }
        const ensured = await applyBacklogItem(root, node, resolved, client, { ...options, ...(productId === undefined ? {} : { productId }) });
        warnings.push(...ensured.warnings);
        itemIds.set(node.relativePath, ensured.itemId);
        itemIds.set(ensured.relativePath, ensured.itemId);
        const pushed = await syncPush(root, ensured.relativePath, { ...options, backlogItemId: ensured.itemId });
        const state = pushed.state === 'unchanged' && (ensured.created || Object.keys(resolved.updateBody).length > 0) ? 'pushed' : pushed.state;
        results.push({
          relativePath: ensured.relativePath, itemId: ensured.itemId, ...(ensured.key === undefined ? {} : { key: ensured.key }),
          state, ...(pushed.remoteId === undefined ? {} : { remoteId: pushed.remoteId }), ...(pushed.conflict === undefined ? {} : { conflict: pushed.conflict }),
          ...(ensured.warnings.length ? { warnings: ensured.warnings } : {}),
        });
        if (pushed.state === 'conflict') { stopped = true; conflictSeen = true; continue; }
        if (preferences.syncMode === 'auto' && preferences.pushTaskStatus && node.status !== 'open') {
          const status = node.status === 'done' ? 'IN_REVIEW' : mapLocalToRemoteStatus(node.status);
          await syncCheckpoint(root, ensured.relativePath, { name: `Status ${status.toLowerCase().replace(/_/g, ' ')}`, backlogStatus: status }, options);
        }
        continue;
      }
      if (action === 'pull') {
        if (node.backlog?.platform.itemId !== undefined) itemIds.set(node.relativePath, node.backlog.platform.itemId);
        const pulled = await syncPull(root, node.relativePath, options);
        let refreshed: { children: number[]; warnings: string[] } = { children: [], warnings: [] };
        if (client && node.backlog?.platform.itemId !== undefined) {
          refreshed = await refreshObserved(root, node, client);
          refreshed.children.forEach(itemId => {
            const entry = remoteOnly.find(candidate => candidate.parentItemId === node.backlog!.platform.itemId);
            if (entry) entry.itemIds.push(itemId); else remoteOnly.push({ parentItemId: node.backlog!.platform.itemId!, itemIds: [itemId] });
          });
          warnings.push(...refreshed.warnings);
        }
        results.push({
          relativePath: node.relativePath, ...(node.backlog?.platform.itemId === undefined ? {} : { itemId: node.backlog.platform.itemId }), state: pulled.state,
          ...(pulled.remoteId === undefined ? {} : { remoteId: pulled.remoteId }), ...(pulled.conflict === undefined ? {} : { conflict: pulled.conflict }),
          ...(refreshed.children.length ? { remoteOnlyChildren: refreshed.children } : {}), ...(refreshed.warnings.length ? { warnings: refreshed.warnings } : {}),
        });
        if (pulled.state === 'conflict') { stopped = true; conflictSeen = true; }
        continue;
      }
      if (node.backlog?.platform.itemId !== undefined) itemIds.set(node.relativePath, node.backlog.platform.itemId);
      const status = await syncStatus(root, node.relativePath, options);
      results.push({ relativePath: node.relativePath, ...(node.backlog?.platform.itemId === undefined ? {} : { itemId: node.backlog.platform.itemId }), state: status.state, ...(status.remoteId === undefined ? {} : { remoteId: status.remoteId }) });
    } catch (error) {
      results.push({ relativePath: node.relativePath, ...(node.backlog?.platform.itemId === undefined ? {} : { itemId: node.backlog.platform.itemId }), state: 'error', error: error instanceof Error ? error.message : String(error) });
      if (action === 'push' || action === 'pull') stopped = true;
    }
  }

  const imported: TreeSyncResult['imported'] = [];
  if (action === 'pull' && options.importNew && client && !conflictSeen && !stopped) {
    if (productId === undefined) warnings.push('Remote-only children were not imported because the workspace has no product binding.');
    else {
      let budget = MAX_IMPORT_ITEMS;
      for (const entry of remoteOnly) {
        for (const itemId of entry.itemIds) {
          if (budget <= 0) { warnings.push('Remote-only import stopped at the 200-item budget.'); break; }
          try {
            const result = await importBacklogTree(root, { ...options, productId, itemId, includeAncestors: true, includeChildren: true, maxItems: budget, dryRun: Boolean(options.dryRun) });
            budget -= result.nodes.length;
            imported.push({ parentItemId: entry.parentItemId, itemId, dryRun: result.dryRun, nodes: result.nodes.length, truncated: result.truncated });
          } catch (error) {
            warnings.push(`Could not import remote-only item ${itemId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  }
  return { action, nodes: results, remoteOnly, stopped, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}), ...(imported.length ? { imported } : {}) };
}

async function refreshObserved(root: string, node: ChangeTreeNode, client: BacklogClient): Promise<{ children: number[]; warnings: string[] }> {
  const sidecar = await readBacklogSidecar((await resolveChangeLocation(root, node.relativePath, { scope: 'active' })).directory);
  if (!sidecar?.platform.itemId) return { children: [], warnings: [] };
  const item = await client.item(sidecar.platform.itemId);
  const directory = (await resolveChangeLocation(root, node.relativePath, { scope: 'active' })).directory;
  const remoteDescription = typeof item.description === 'string' ? item.description : undefined;
  const remote = remotePlanning(item);
  const warnings: string[] = [];
  if (item.title !== sidecar.node.title) warnings.push(`Remote title "${item.title}" differs from local "${sidecar.node.title}"; title adoption happens on push.`);
  if (remoteDescription !== undefined && sidecar.planning?.description !== undefined && digest(sidecar.planning.description) !== digest(remoteDescription)) warnings.push('Remote description differs from the local authored description; push to reconcile or pull it explicitly.');
  for (const { field } of PLANNING_FIELDS) {
    const local = sidecar.planning?.[field], remoteValue = remote[field];
    if (local !== undefined && remoteValue !== undefined && !equalPlanning(field, local, remoteValue)) warnings.push(`${field} differs on the platform (local ${String(local)}, remote ${String(remoteValue)}); push to reconcile.`);
  }

  const observed = withObservedPlatform(sidecar, {
    key: item.key ?? undefined,
    parentItemId: item.parentId ?? null,
    remoteStatus: REMOTE_STATUSES.includes(item.status as BacklogRemoteStatus) ? item.status as BacklogRemoteStatus : undefined,
    remoteUpdatedAt: item.updatedAt,
    remoteTitle: item.title,
    remoteDescriptionSha256: remoteDescription === undefined ? undefined : digest(remoteDescription),
    descriptionRevision: Number.isSafeInteger(item.descriptionRevision) ? Number(item.descriptionRevision) : undefined,
    ...remote,
  }, 'pull');
  await persistSidecar(directory, withBaselines(observed, remoteDescription === undefined ? {} : { lastPushedDescriptionSha256: digest(remoteDescription) }, 'pull'));
  const local = new Set<number>();
  for (const entry of await scanChangeDirectories(root, { scope: 'active' })) {
    const child = await readBacklogSidecar(entry.directory);
    if (child?.platform.itemId !== undefined && child.platform.parentItemId === item.id) local.add(child.platform.itemId);
  }
  const children: number[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await client.children(item.id, cursor);
    for (const child of response.items) if (!local.has(child.id)) children.push(child.id);
    if (!response.nextCursor || seen.has(response.nextCursor)) break;
    seen.add(response.nextCursor); cursor = response.nextCursor;
  }
  return { children, warnings };
}

export interface LocalPlanningUpdate {
  title?: string;
  description?: string;
  priorityLevel?: BacklogPriorityLevel;
  storyPoints?: number;
  startDate?: string;
  dueDate?: string;
}

/** Author planning fields in the local backlog sidecar only; `sync push --tree --yes` publishes them. */
export async function updateLocalBacklogPlanning(root: string, reference: string, update: LocalPlanningUpdate) {
  const location = await resolveChangeLocation(root, reference, { scope: 'active' });
  const sidecar = await readBacklogSidecar(location.directory);
  if (!sidecar) throw new WorkflowError('missing_backlog_sidecar', `${location.relativePath} has no backlog.json sidecar.`, 'Backlog planning applies to nodes created with `--as <type>` or imported from the platform.');
  if (update.title !== undefined && !update.title.trim()) throw new WorkflowError('invalid_input', 'Title cannot be empty.', 'Pass a non-empty --title value.');
  const planning: BacklogPlanningDetails = {
    ...(update.description === undefined ? {} : { description: update.description }),
    ...(update.priorityLevel === undefined ? {} : { priorityLevel: update.priorityLevel }),
    ...(update.storyPoints === undefined ? {} : { storyPoints: update.storyPoints }),
    ...(update.startDate === undefined ? {} : { startDate: update.startDate }),
    ...(update.dueDate === undefined ? {} : { dueDate: update.dueDate }),
  };
  const titled = update.title === undefined ? sidecar : { ...sidecar, node: { ...sidecar.node, title: update.title } };
  const next = Object.keys(planning).length ? withPlanning(titled, planning, 'cli') : { ...titled, meta: { ...titled.meta, updatedAt: new Date().toISOString(), lastWriter: 'cli' } };
  await writeBacklogSidecar(location.directory, next);
  return { relativePath: location.relativePath, itemId: next.platform.itemId, title: next.node.title, planning: next.planning ?? {} };
}

export interface TreeDeliveryResult {
  status: 'DONE';
  nodes: Array<{ relativePath: string; state: string; delivery?: unknown; error?: string; conflict?: string }>;
  completed: number;
  blocked: number;
}

/** Delivery is explicit and bottom-up: children close on the platform before their parent. */
export async function deliverTree(root: string, reference: string, input: { status: 'DONE'; summary?: string; withChildren?: boolean }, options: BacklogTreeOptions = {}): Promise<TreeDeliveryResult> {
  const target = await buildNode(root, reference);
  const nodes = input.withChildren ? flattenTree(target).reverse() : [target];
  const results: TreeDeliveryResult['nodes'] = [];
  let completed = 0, blocked = 0;
  for (const node of nodes) {
    try {
      const result = await syncDeliver(root, node.relativePath, { status: input.status, ...(input.summary === undefined ? {} : { summary: input.summary }) }, options);
      results.push({ relativePath: node.relativePath, state: result.state, ...(result.delivery === undefined ? {} : { delivery: result.delivery }), ...(result.conflict === undefined ? {} : { conflict: result.conflict }) });
      if (result.state === 'delivered') completed += 1;
      if (result.state === 'conflict') { blocked += 1; break; }
    } catch (error) {
      blocked += 1;
      results.push({ relativePath: node.relativePath, state: 'error', error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return { status: input.status, nodes: results, completed, blocked };
}
