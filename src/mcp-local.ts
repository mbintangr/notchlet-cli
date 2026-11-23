import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import {
  addCheckToChange, addDesignDecisionToChange, addRequirementToChange, addScenarioToChange, addTaskToChange,
  appendEvidence, applyChangeUpdate, assertLeafAuthorable, authorCapabilityDeltaOperation, buildChangeTree, buildNode,
  captureCapabilityBaseline, changeItemPatchFields, coverageEvidenceFrom, deleteCapabilityDeltaOperation,
  evaluateState, evaluateVerificationFacets, findWorkspace, flattenTree, inspectChangeArtifacts, inspectEvidence, instructions,
  listChanges, mutateChange, parseChangeOperations, persistChangeOperations, readChange, readiness, removeChangeItem, resolveChangeLocation,
  resolveEvidenceScope, scaffold, scaffoldNode, transitionTask, treeCounts,
  updateChangeItem, verificationRecovery, WorkflowError, writeChangeArtifacts,
  type BacklogItemType, type Change, type ChangeCollection, type ChangeItemKind, type ChangeItemPatch, type ChangeTreeNode,
  type EvidenceFilter, type EvidenceWriteInput, type TaskStatus, type WorkflowAction, type VerificationFacets,
} from '@notchlet/core';
import { persistVerificationLog, runChecks, summarizeVerification } from './verify.js';

export type LocalMcpOptions = {
  workspace?: string;
  stdin?: Readable;
  stdout?: Writable;
};

type JsonObject = Record<string, unknown>;

function textResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function artifactContents(root: string, ref: string, change: Change): Promise<Record<string, string>> {
  const directory = (await resolveChangeLocation(root, ref, { scope: 'merged' })).directory;
  const result: Record<string, string> = {};
  for (const relative of Object.values(change.artifacts)) {
    try { result[relative] = await readFile(path.join(directory, relative), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}

async function verificationFacets(root: string, id: string, change: Change) {
  return evaluateVerificationFacets(root, id, change);
}

async function resolveChangeId(root: string, input: string): Promise<string> {
  try { return (await resolveChangeLocation(root, input, { scope: 'active' })).relativePath; }
  catch (error) {
    if (error instanceof WorkflowError) throw new Error(`${error.message} Use notchlet_change_list to find a change ID, name, or relative path.`);
    throw error;
  }
}

async function assertLeafTools(root: string, ref: string, operation: string): Promise<void> {
  assertLeafAuthorable(await buildNode(root, ref), operation);
}

function compactTreeNode(node: ChangeTreeNode, remainingDepth?: number): Record<string, unknown> {
  return {
    relativePath: node.relativePath,
    id: node.id,
    name: node.name,
    scope: node.scope,
    status: node.closed ? 'done' : node.status,
    closed: node.closed,
    backlog: node.backlog ? {
      itemType: node.backlog.node.itemType,
      title: node.backlog.node.title,
      key: node.backlog.platform.key ?? null,
      itemId: node.backlog.platform.itemId ?? null,
      sync: node.backlog.sync.state,
    } : null,
    ...(remainingDepth === undefined || remainingDepth > 1 ? { children: node.children.map(child => compactTreeNode(child, remainingDepth === undefined ? undefined : remainingDepth - 1)) } : {}),
  };
}

function stringArg(args: JsonObject, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: ${name}.`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Argument ${name} must be a non-empty string.`);
  return value;
}

function stringListArg(args: JsonObject, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`Argument ${name} must be an array of non-empty strings.`);
  return value as string[];
}
function objectListArg(args: JsonObject, name: string): Array<Record<string, unknown>> | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error(`Argument ${name} must be an array of objects.`);
  return value as Array<Record<string, unknown>>;
}

const tool = (name: string, description: string, properties: JsonObject, required: string[] = []) => ({
  name, description, inputSchema: { type: 'object' as const, properties, ...(required.length ? { required } : {}), additionalProperties: false },
});

const tools = [
  tool('notchlet_workspace_status', 'Show local workspace changes with readiness and task progress. Pass changeId for full state.', {
    changeId: { type: 'string', description: 'Optional change ID or exact name' },
  }),
  tool('notchlet_change_list', 'List local changes with task counts, readiness, and relative hierarchy paths.', {}),
  tool('notchlet_change_tree', 'Show the local backlog hierarchy with derived status and counts; pass a change reference to scope to one subtree.', {
    changeId: { type: 'string', description: 'Optional change ID, name, or relative path; defaults to the whole workspace' },
    depth: { type: 'number', description: 'Optional maximum depth to include (1 = node only)' },
  }),
  tool('notchlet_change_get', 'Read one change, its readiness blockers, derived state, and verification status.', {
    changeId: { type: 'string', description: 'Change ID, name, or relative path' },
  }, ['changeId']),
  tool('notchlet_change_create', 'Create a local change. Quick mode needs no design artifacts; standard mode scaffolds design.md. Pass changeType (and parent for non-epics) to create a backlog node.', {
    name: { type: 'string', description: 'Human-readable change name' },
    mode: { type: 'string', enum: ['quick', 'standard'], description: 'Defaults to quick' },
    changeType: { type: 'string', enum: ['epic', 'story', 'task', 'subtask'], description: 'Backlog node type; stories/tasks/subtasks require parent' },
    parent: { type: 'string', description: 'Parent change ID, name, or relative path; requires changeType' },
    title: { type: 'string', description: 'Backlog node title; defaults to name' },
    slug: { type: 'string', description: 'Folder slug; defaults to the title slug' },
  }, ['name']),
  tool('notchlet_change_update', 'Update the change intent, outcome, or capability declaration, or edit one authored item in place with kind and itemId. Revision is bumped atomically; pass revision to reject a stale write.', {
    changeId: { type: 'string' },
    intent: { type: 'string' },
    outcome: { type: 'string' },
    capabilityName: { type: 'string' },
    capabilityImpact: { type: 'string', enum: ['none', 'delta'] },
    capabilityRationale: { type: 'string' },
    kind: { type: 'string', enum: ['requirement', 'check', 'scenario', 'decision', 'task'], description: 'Edit one authored item when provided with itemId' },
    itemId: { type: 'string', description: 'ID of the item to edit' },
    title: { type: 'string' },
    description: { type: 'string' },
    command: { type: 'string', description: 'Check command' },
    checkKind: { type: 'string', enum: ['command', 'manual', 'browser', 'http', 'ui'], description: 'Check execution kind' },
    url: { type: 'string', description: 'Browser, HTTP, or UI check URL' },
    expectedStatus: { type: 'number', description: 'Expected HTTP status for a browser or HTTP check' },
    waitFor: { type: 'string', description: 'UI check: selector that must render before capture' },
    settleMs: { type: 'number', description: 'UI check: settle delay after load before capture' },
    expectedSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must exist in the rendered DOM' },
    expectedVisibleSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must be present and visibly rendered' },
    expectedHiddenSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must not be visibly rendered' },
    expectedAbsentSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must be absent from the DOM; present-but-hidden fails' },
    expectedEnabledSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must be present and enabled' },
    expectedText: { type: 'string', description: 'UI check: text that must appear in rendered content' },
    expectedTitle: { type: 'string', description: 'UI check: exact document title' },
    expectedScopedText: { type: 'array', items: { type: 'object' }, description: 'UI check: [{selector, contains}] scoped text assertions' },
    steps: { type: 'array', items: { type: 'object' }, description: 'UI check: ordered interaction steps, for example {action:"click",selector:"#save"}' },
    captureArtifacts: { type: 'string', enum: ['never', 'on-failure', 'always'], description: 'UI check: capture policy' },
    expectedNoConsoleErrors: { type: 'boolean', description: 'UI check: fail when the page logs console errors' },
    fullPage: { type: 'boolean', description: 'UI check: capture the full scrollable page' },
    requirementId: { type: 'string', description: 'Scenario requirement link' },
    when: { type: 'string', description: 'Scenario WHEN statement' },
    then: { type: 'string', description: 'Scenario THEN statement' },
    decision: { type: 'string', description: 'Design decision' },
    rationale: { type: 'string', description: 'Design decision rationale' },
    dependencies: { type: 'array', items: { type: 'string' }, description: 'Task dependency IDs' },
    requirementIds: { type: 'array', items: { type: 'string' }, description: 'Task or check requirement links' },
    taskIds: { type: 'array', items: { type: 'string' }, description: 'Check task links' },
    revision: { type: 'number', description: 'Expected change revision; rejects a stale write' },
  }, ['changeId']),
  tool('notchlet_change_add', 'Add authored content to a change. Task requirementIds and check requirementIds/taskIds must reference existing items.', {
    changeId: { type: 'string' },
    kind: { type: 'string', enum: ['requirement', 'check', 'scenario', 'decision', 'task'] },
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    command: { type: 'string', description: 'Executable command for a check' },
    checkKind: { type: 'string', enum: ['command', 'manual', 'browser', 'http', 'ui'], description: 'Check execution kind' },
    url: { type: 'string', description: 'Browser, HTTP, or UI check URL' },
    expectedStatus: { type: 'number', description: 'Expected HTTP status for a browser or HTTP check' },
    waitFor: { type: 'string', description: 'UI check: selector that must render before capture' },
    settleMs: { type: 'number', description: 'UI check: settle delay after load before capture' },
    expectedSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must exist in the rendered DOM' },
    expectedVisibleSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must be present and visibly rendered' },
    expectedHiddenSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must not be visibly rendered' },
    expectedAbsentSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must be absent from the DOM; present-but-hidden fails' },
    expectedEnabledSelectors: { type: 'array', items: { type: 'string' }, description: 'UI check: selectors that must be present and enabled' },
    expectedText: { type: 'string', description: 'UI check: text that must appear in rendered content' },
    expectedTitle: { type: 'string', description: 'UI check: exact document title' },
    expectedScopedText: { type: 'array', items: { type: 'object' }, description: 'UI check: [{selector, contains}] scoped text assertions' },
    steps: { type: 'array', items: { type: 'object' }, description: 'UI check: ordered interaction steps, for example {action:"click",selector:"#save"}' },
    captureArtifacts: { type: 'string', enum: ['never', 'on-failure', 'always'], description: 'UI check: capture policy' },
    expectedNoConsoleErrors: { type: 'boolean', description: 'UI check: fail when the page logs console errors' },
    fullPage: { type: 'boolean', description: 'UI check: capture the full scrollable page' },
    requirementId: { type: 'string', description: 'Scenario requirement link' },
    when: { type: 'string', description: 'Scenario WHEN statement' },
    then: { type: 'string', description: 'Scenario THEN statement' },
    decision: { type: 'string', description: 'Design decision' },
    rationale: { type: 'string', description: 'Design decision rationale' },
    dependencies: { type: 'array', items: { type: 'string' }, description: 'Task dependency IDs' },
    requirementIds: { type: 'array', items: { type: 'string' }, description: 'Task or check requirement links' },
    taskIds: { type: 'array', items: { type: 'string' }, description: 'Check task links' },
    revision: { type: 'number', description: 'Expected change revision; rejects a stale write' },
  }, ['changeId', 'kind', 'id']),
  tool('notchlet_change_apply', 'Apply ordered field/item operations atomically from one array. The whole batch validates against the final state, writes once, bumps revision once, and rolls back on failure. Capability delta operations are not accepted.', {
    changeId: { type: 'string' },
    revision: { type: 'number', description: 'Expected change revision; rejects a stale write' },
    operations: {
      type: 'array',
      description: 'Ordered operations: { op: "field", ... } or { op: "add" | "update" | "remove", kind, id, ... }',
      items: { type: 'object', additionalProperties: true },
    },
  }, ['changeId', 'operations']),
  tool('notchlet_change_render', 'Inspect generated proposal/spec/tasks artifact drift, or write current artifacts atomically and bump the revision once. JSON is canonical; set markdown=true to also declare and render Markdown views.', {
    changeId: { type: 'string' },
    write: { type: 'boolean', description: 'Write current rendered artifacts instead of only inspecting status' },
    force: { type: 'boolean', description: 'Overwrite artifacts that lack the generated-content marker' },
    markdown: { type: 'boolean', description: 'Also declare and render proposal.md, spec.md, and tasks.md views' },
  }, ['changeId']),
  tool('notchlet_change_baseline', 'Capture the current capability baseline revision for a change with an optional expected change revision.', {
    changeId: { type: 'string' },
    capabilityName: { type: 'string', description: 'Optional capability name; defaults to the change declaration or ID' },
    revision: { type: 'number', description: 'Expected change revision; rejects a stale write' },
  }, ['changeId']),
  tool('notchlet_change_delta', 'Author or delete an explicit capability delta operation. Add/update/remove snapshot the authored requirement and linked scenarios.', {
    changeId: { type: 'string' },
    operation: { type: 'string', enum: ['add', 'update', 'remove', 'delete'] },
    requirementId: { type: 'string' },
    rationale: { type: 'string', description: 'Required for add/update/remove; declares why the capability changes' },
    revision: { type: 'number', description: 'Expected change revision; rejects a stale write' },
  }, ['changeId', 'operation', 'requirementId']),
  tool('notchlet_change_remove', 'Remove authored content by kind and ID. Checks referenced by recorded evidence are protected. Pass revision to reject a stale write.', {
    changeId: { type: 'string' },
    kind: { type: 'string', enum: ['requirement', 'check', 'scenario', 'decision', 'task'] },
    itemId: { type: 'string' },
    revision: { type: 'number', description: 'Expected change revision; rejects a stale write' },
  }, ['changeId', 'kind', 'itemId']),
  tool('notchlet_task_transition', 'Move a task through pending -> in_progress -> completed. Completing without current passed evidence returns a warning; requireEvidence blocks it with evidence_required.', {
    changeId: { type: 'string' },
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    revision: { type: 'number', description: 'Expected revision; defaults to the current revision' },
    force: { type: 'boolean', description: 'Allow an out-of-order transition' },
    requireEvidence: { type: 'boolean', description: 'Block completion unless evidence referencing this task is current' },
  }, ['changeId', 'taskId', 'status']),
  tool('notchlet_verify', 'Run command, HTTP, browser, and UI checks declared on a change. UI checks capture one settled rendered page and assert rendered selectors, text, and console errors. Set record=true to append check evidence scoped to executed checks plus their declared or explicitly selected requirement/task links.', {
    changeId: { type: 'string' },
    checkIds: { type: 'array', items: { type: 'string' }, description: 'Optional subset of check IDs' },
    record: { type: 'boolean', description: 'Record the result as evidence' },
    requirementIds: { type: 'array', items: { type: 'string' }, description: 'Extra requirement links; requires record=true' },
    taskIds: { type: 'array', items: { type: 'string' }, description: 'Extra task links; requires record=true' },
    timeoutMs: { type: 'number', description: 'Per-check timeout (default 120000)' },
    workingDirectory: { type: 'string', description: 'Working directory for command checks' },
    readyTimeoutMs: { type: 'number', description: 'Serve readiness timeout for checks that start a server' },
    readyIntervalMs: { type: 'number', description: 'Serve readiness polling interval' },
    browser: { type: 'string', description: 'UI capture browser executable override' },
    settleMs: { type: 'number', description: 'UI capture default settle delay, overriding per-check defaults' },
    fullPage: { type: 'boolean', description: 'UI capture full-page screenshots, overriding per-check defaults' },
    viewport: {
      type: 'object',
      description: 'UI capture viewport',
      properties: { width: { type: 'number' }, height: { type: 'number' } },
      additionalProperties: false,
    },
  }, ['changeId']),
  tool('notchlet_evidence_record', 'Append evidence for a change. checkIds must reference declared checks.', {
    changeId: { type: 'string' },
    kind: { type: 'string', enum: ['check', 'note', 'artifact'] },
    outcome: { type: 'string', enum: ['passed', 'failed', 'informational'] },
    summary: { type: 'string' },
    requirementIds: { type: 'array', items: { type: 'string' } },
    taskIds: { type: 'array', items: { type: 'string' } },
    checkIds: { type: 'array', items: { type: 'string' } },
    uri: { type: 'string' },
  }, ['changeId', 'kind', 'outcome', 'summary']),
  tool('notchlet_evidence_list', 'List evidence records with freshness, linked IDs, and recovery commands. Filter by checkId, requirementId, taskId, stale, or failed.', {
    changeId: { type: 'string' },
    checkId: { type: 'string', description: 'Only records that executed this check' },
    requirementId: { type: 'string', description: 'Only records linked to this requirement' },
    taskId: { type: 'string', description: 'Only records linked to this task' },
    stale: { type: 'boolean', description: 'Only stale records' },
    failed: { type: 'boolean', description: 'Only failed records' },
  }, ['changeId']),
  tool('notchlet_instructions', 'Get action-specific workflow instructions from the change state.', {
    changeId: { type: 'string' },
    action: { type: 'string', enum: ['plan', 'revise', 'implement', 'verify', 'resume'] },
  }, ['changeId']),
];

/** Exported contract: local MCP tool names and descriptions as advertised to clients. */
export const localToolDefinitions = tools;

function collectionFor(kind: string): ChangeCollection {
  const map: Record<string, ChangeCollection> = {
    requirement: 'requirements', check: 'checks', scenario: 'acceptanceScenarios', decision: 'designDecisions', task: 'tasks',
  };
  const collection = map[kind];
  if (!collection) throw new Error(`Unknown kind "${kind}". Use requirement, check, scenario, decision, or task.`);
  return collection;
}

function collectionKind(kind: string): ChangeItemKind {
  if (kind === 'requirement' || kind === 'check' || kind === 'scenario' || kind === 'decision' || kind === 'task') return kind;
  throw new Error(`Unknown kind "${kind}". Use requirement, check, scenario, decision, or task.`);
}

function revisionArg(args: JsonObject): number | undefined {
  if (args.revision === undefined) return undefined;
  if (typeof args.revision !== 'number' || !Number.isInteger(args.revision) || args.revision < 0) throw new Error('revision must be a non-negative integer.');
  return args.revision;
}

const PATCH_FIELDS = ['title', 'description', 'command', 'url', 'expectedStatus', 'waitFor', 'settleMs', 'expectedSelectors', 'expectedVisibleSelectors', 'expectedHiddenSelectors', 'expectedAbsentSelectors', 'expectedEnabledSelectors', 'expectedText', 'expectedTitle', 'expectedScopedText', 'steps', 'captureArtifacts', 'expectedNoConsoleErrors', 'fullPage', 'requirementId', 'when', 'then', 'decision', 'rationale', 'dependencies', 'requirementIds', 'taskIds', 'kind'];

function booleanArg(args: JsonObject, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Argument ${name} must be a boolean.`);
  return value;
}

function nonNegativeIntegerArg(args: JsonObject, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Argument ${name} must be a non-negative integer.`);
  return value;
}

function patchArgValue(args: JsonObject, field: string): unknown {
  return field === 'kind' ? args.checkKind : args[field];
}

function itemPatchArg(kind: ChangeItemKind, args: JsonObject): ChangeItemPatch {
  const allowed = changeItemPatchFields(kind);
  for (const field of PATCH_FIELDS) {
    if (patchArgValue(args, field) !== undefined && !allowed.includes(field)) throw new Error(`${kind} items do not support the "${field}" field. Edit only: ${allowed.join(', ')}.`);
  }
  const patch: Record<string, unknown> = {};
  for (const field of allowed) {
    const value = patchArgValue(args, field);
    if (value === undefined) continue;
    if (field === 'expectedStatus') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) throw new Error('expectedStatus must be an HTTP status between 100 and 599.');
      patch[field] = value;
    } else if (field === 'settleMs') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('settleMs must be a non-negative integer.');
      patch[field] = value;
    } else if (field === 'expectedNoConsoleErrors' || field === 'fullPage') {
      if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean.`);
      patch[field] = value;
    } else if (field === 'dependencies' || field === 'requirementIds' || field === 'taskIds' || field === 'expectedSelectors' || field === 'expectedVisibleSelectors' || field === 'expectedHiddenSelectors' || field === 'expectedAbsentSelectors' || field === 'expectedEnabledSelectors') {
      patch[field] = stringListArg(args, field)!;
    } else if (field === 'expectedScopedText' || field === 'steps') {
      patch[field] = objectListArg(args, field)!;
    } else if (field === 'captureArtifacts') {
      const policy = stringArg(args, field)!;
      if (!['never', 'on-failure', 'always'].includes(policy)) throw new Error('captureArtifacts must be never, on-failure, or always.');
      patch[field] = policy;
    } else if (field === 'kind') {
      patch[field] = stringArg(args, 'checkKind')!;
    } else {
      patch[field] = stringArg(args, field)!;
    }
  }
  if (Object.keys(patch).length === 0) throw new Error(`Provide at least one ${kind} field to update: ${allowed.join(', ')}.`);
  return patch as ChangeItemPatch;
}

async function callTool(root: string, name: string, args: JsonObject): Promise<unknown> {
  if (name === 'notchlet_workspace_status') {
    const changes = await listChanges(root);
    const changeId = typeof args.changeId === 'string' ? await resolveChangeId(root, args.changeId) : undefined;
    if (!changeId) return { workspace: root, changes };
    const change = await readChange(root, changeId);
    const contents = await artifactContents(root, changeId, change);
    const facets = await verificationFacets(root, changeId, change);
    const recoverable = [...facets.missing, ...facets.failed, ...facets.stale, ...facets.unknown];
    const rollup = (await buildNode(root, changeId)).children.length > 0;
    return {
      change,
      readiness: readiness(change, contents, coverageEvidenceFrom(facets), rollup ? { rollup: true } : {}),
      state: evaluateState(change, { ...facets, coverageEvidence: coverageEvidenceFrom(facets) }, contents),
      verification: facets,
      ...(recoverable.length ? { recovery: verificationRecovery(changeId, recoverable) } : {}),
    };
  }
  if (name === 'notchlet_change_list') return { changes: await listChanges(root) };

  if (name === 'notchlet_change_tree') {
    const depth = args.depth;
    if (depth !== undefined && (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1)) throw new Error('depth must be a positive integer.');
    const depthLimit = depth === undefined ? undefined : depth;
    const tree = await buildChangeTree(root);
    if (typeof args.changeId !== 'string' || !args.changeId.trim()) {
      return { counts: tree.counts, warnings: tree.warnings, roots: tree.roots.map(node => compactTreeNode(node, depthLimit)) };
    }
    const node = await buildNode(root, args.changeId);
    return { relativePath: node.relativePath, counts: treeCounts(flattenTree(node)), warnings: tree.warnings, node: compactTreeNode(node, depthLimit) };
  }

  if (name === 'notchlet_change_create') {
    const mode = args.mode === 'standard' ? 'standard' : 'quick';
    const nameArg = stringArg(args, 'name')!;
    const typeInput = stringArg(args, 'changeType', false)?.toLowerCase();
    const parent = stringArg(args, 'parent', false);
    const title = stringArg(args, 'title', false);
    const slug = stringArg(args, 'slug', false);
    if (!typeInput) {
      if (parent !== undefined || title !== undefined || slug !== undefined) throw new Error('changeType is required when using parent, title, or slug.');
      return { change: await scaffold(root, nameArg, mode) };
    }
    if (!['epic', 'story', 'task', 'subtask'].includes(typeInput)) throw new Error('changeType must be epic, story, task, or subtask.');
    if (typeInput !== 'epic' && parent === undefined) throw new Error(`changeType ${typeInput} requires a parent.`);
    if (typeInput === 'epic' && parent !== undefined) throw new Error('An epic cannot have a parent.');
    const result = await scaffoldNode(root, {
      name: nameArg,
      itemType: typeInput.toUpperCase() as BacklogItemType,
      mode,
      ...(parent === undefined ? {} : { parent }),
      ...(title === undefined ? {} : { title }),
      ...(slug === undefined ? {} : { slug }),
    });
    return { change: result.change, relativePath: result.relativePath, backlog: result.backlog };
  }

  const changeIdInput = stringArg(args, 'changeId');
  if (!changeIdInput) throw new Error('changeId is required.');
  const changeId = await resolveChangeId(root, changeIdInput);

  if (name === 'notchlet_change_get') {
    const change = await readChange(root, changeId);
    const contents = await artifactContents(root, changeId, change);
    const facets = await verificationFacets(root, changeId, change);
    const recoverable = [...facets.missing, ...facets.failed, ...facets.stale, ...facets.unknown];
    const rollup = (await buildNode(root, changeId)).children.length > 0;
    return {
      change,
      readiness: readiness(change, contents, coverageEvidenceFrom(facets), rollup ? { rollup: true } : {}),
      state: evaluateState(change, { ...facets, coverageEvidence: coverageEvidenceFrom(facets) }, contents),
      verification: facets,
      ...(recoverable.length ? { recovery: verificationRecovery(changeId, recoverable) } : {}),
    };
  }
  if (name === 'notchlet_change_render') {
    return args.write === true
      ? await writeChangeArtifacts(root, changeId, { force: args.force === true, markdown: args.markdown === true })
      : await inspectChangeArtifacts(root, changeId);
  }
  if (name === 'notchlet_change_update') {
    const revision = revisionArg(args);
    const kindInput = stringArg(args, 'kind', false);
    const itemId = stringArg(args, 'itemId', false);
    if (kindInput !== undefined || itemId !== undefined) {
      if (!kindInput) throw new Error('itemId requires kind.');
      if (!itemId) throw new Error('kind requires itemId.');
      const kind = collectionKind(kindInput);
      if (kind === 'task') await assertLeafTools(root, changeId, 'edit tasks');
      const patch = itemPatchArg(kind, args);
      return { change: await mutateChange(root, changeId, change => updateChangeItem(change, kind, itemId, patch), revision === undefined ? {} : { expectedRevision: revision }) };
    }
    const update: Parameters<typeof applyChangeUpdate>[1] = {};
    if (typeof args.intent === 'string') update.intent = args.intent;
    if (typeof args.outcome === 'string') update.outcome = args.outcome;
    if (typeof args.capabilityName === 'string') update.capabilityName = args.capabilityName;
    if (args.capabilityImpact === 'none' || args.capabilityImpact === 'delta') update.capabilityImpact = args.capabilityImpact;
    if (typeof args.capabilityRationale === 'string') update.capabilityRationale = args.capabilityRationale;
    return { change: await mutateChange(root, changeId, change => applyChangeUpdate(change, update), revision === undefined ? {} : { expectedRevision: revision }) };
  }
  if (name === 'notchlet_change_baseline') {
    const revision = typeof args.revision === 'number' && Number.isInteger(args.revision) && args.revision >= 0 ? args.revision : undefined;
    if (args.revision !== undefined && revision === undefined) throw new Error('revision must be a non-negative integer.');
    return captureCapabilityBaseline(root, changeId, {
      ...(typeof args.capabilityName === 'string' && args.capabilityName.trim() ? { capabilityName: args.capabilityName } : {}),
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }
  if (name === 'notchlet_change_delta') {
    const operation = stringArg(args, 'operation')!;
    if (!['add', 'update', 'remove', 'delete'].includes(operation)) throw new Error('operation must be add, update, remove, or delete.');
    const requirementId = stringArg(args, 'requirementId')!;
    const revision = typeof args.revision === 'number' && Number.isInteger(args.revision) && args.revision >= 0 ? args.revision : undefined;
    if (args.revision !== undefined && revision === undefined) throw new Error('revision must be a non-negative integer.');
    if (operation === 'delete') {
      return { change: await mutateChange(root, changeId, change => deleteCapabilityDeltaOperation(change, requirementId), revision === undefined ? {} : { expectedRevision: revision }) };
    }
    const rationale = stringArg(args, 'rationale')!;
    return { change: await mutateChange(root, changeId, change => authorCapabilityDeltaOperation(change, { operation: operation as 'add' | 'update' | 'remove', requirementId, rationale }), revision === undefined ? {} : { expectedRevision: revision }) };
  }
  if (name === 'notchlet_change_add') {
    const kind = stringArg(args, 'kind')!;
    const id = stringArg(args, 'id')!;
    if (kind === 'task') await assertLeafTools(root, changeId, 'add tasks');
    const revision = revisionArg(args);
    const change = await mutateChange(root, changeId, current => {
      if (kind === 'requirement') return addRequirementToChange(current, { id, title: stringArg(args, 'title') ?? id, description: stringArg(args, 'description') ?? stringArg(args, 'title') ?? id });
      if (kind === 'check') {
        const requirementIds = stringListArg(args, 'requirementIds');
        const taskIds = stringListArg(args, 'taskIds');
        const expectedStatus = args.expectedStatus === undefined ? undefined : args.expectedStatus;
        if (expectedStatus !== undefined && (typeof expectedStatus !== 'number' || !Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599)) throw new Error('expectedStatus must be an HTTP status between 100 and 599.');
        const waitFor = stringArg(args, 'waitFor', false);
        const settleMs = nonNegativeIntegerArg(args, 'settleMs');
        const expectedSelectors = stringListArg(args, 'expectedSelectors');
        const expectedVisibleSelectors = stringListArg(args, 'expectedVisibleSelectors');
        const expectedHiddenSelectors = stringListArg(args, 'expectedHiddenSelectors');
        const expectedAbsentSelectors = stringListArg(args, 'expectedAbsentSelectors');
        const expectedEnabledSelectors = stringListArg(args, 'expectedEnabledSelectors');
        const expectedText = stringArg(args, 'expectedText', false);
        const expectedTitle = stringArg(args, 'expectedTitle', false);
        const expectedScopedText = objectListArg(args, 'expectedScopedText');
        const steps = objectListArg(args, 'steps');
        const captureArtifacts = stringArg(args, 'captureArtifacts', false);
        if (captureArtifacts !== undefined && !['never', 'on-failure', 'always'].includes(captureArtifacts)) throw new Error('captureArtifacts must be never, on-failure, or always.');
        const expectedNoConsoleErrors = booleanArg(args, 'expectedNoConsoleErrors');
        const fullPage = booleanArg(args, 'fullPage');
        return addCheckToChange(current, {
          id,
          description: stringArg(args, 'description') ?? id,
          ...(typeof args.checkKind === 'string' ? { kind: args.checkKind as Change['checks'][number]['kind'] } : {}),
          ...(typeof args.command === 'string' && args.command.trim() ? { command: args.command } : {}),
          ...(typeof args.url === 'string' && args.url.trim() ? { url: args.url } : {}),
          ...(expectedStatus === undefined ? {} : { expectedStatus }),
          ...(waitFor === undefined ? {} : { waitFor }),
          ...(settleMs === undefined ? {} : { settleMs }),
          ...(expectedSelectors?.length ? { expectedSelectors } : {}),
          ...(expectedVisibleSelectors?.length ? { expectedVisibleSelectors } : {}),
          ...(expectedHiddenSelectors?.length ? { expectedHiddenSelectors } : {}),
          ...(expectedAbsentSelectors?.length ? { expectedAbsentSelectors } : {}),
          ...(expectedEnabledSelectors?.length ? { expectedEnabledSelectors } : {}),
          ...(expectedText === undefined ? {} : { expectedText }),
          ...(expectedTitle === undefined ? {} : { expectedTitle }),
          ...(expectedScopedText === undefined ? {} : { expectedScopedText: expectedScopedText as unknown as NonNullable<Change['checks'][number]['expectedScopedText']> }),
          ...(steps === undefined ? {} : { steps: steps as unknown as NonNullable<Change['checks'][number]['steps']> }),
          ...(captureArtifacts === undefined ? {} : { captureArtifacts: captureArtifacts as NonNullable<Change['checks'][number]['captureArtifacts']> }),
          ...(expectedNoConsoleErrors === undefined ? {} : { expectedNoConsoleErrors }),
          ...(fullPage === undefined ? {} : { fullPage }),
          ...(requirementIds?.length ? { requirementIds } : {}),
          ...(taskIds?.length ? { taskIds } : {}),
        });
      }
      if (kind === 'scenario') return addScenarioToChange(current, { id, requirementId: stringArg(args, 'requirementId')!, when: stringArg(args, 'when')!, then: stringArg(args, 'then')! });
      if (kind === 'decision') return addDesignDecisionToChange(current, { id, decision: stringArg(args, 'decision')!, rationale: stringArg(args, 'rationale')! });
      if (kind === 'task') return addTaskToChange(current, { id, title: stringArg(args, 'title') ?? id, status: 'pending', dependencies: stringListArg(args, 'dependencies') ?? [], requirementIds: stringListArg(args, 'requirementIds') ?? [] });
      throw new Error(`Unknown kind "${kind}". Use requirement, check, scenario, decision, or task.`);
    }, revision === undefined ? {} : { expectedRevision: revision });
    return { change };
  }
  if (name === 'notchlet_change_apply') {
    const revision = revisionArg(args);
    const operations = parseChangeOperations(args.operations);
    if (operations.some(operation => 'kind' in operation && operation.kind === 'task')) await assertLeafTools(root, changeId, 'edit tasks');
    return persistChangeOperations(root, changeId, operations, revision === undefined ? {} : { expectedRevision: revision });
  }
  if (name === 'notchlet_change_remove') {
    const kind = stringArg(args, 'kind')!;
    if (collectionKind(kind) === 'task') await assertLeafTools(root, changeId, 'remove tasks');
    const revision = revisionArg(args);
    return { change: await removeChangeItem(root, changeId, collectionFor(kind), stringArg(args, 'itemId')!, revision === undefined ? {} : { expectedRevision: revision }) };
  }
  if (name === 'notchlet_task_transition') {
    const taskId = stringArg(args, 'taskId')!;
    const status = stringArg(args, 'status')!;
    if (!['pending', 'in_progress', 'completed'].includes(status)) throw new Error('status must be pending, in_progress, or completed.');
    await assertLeafTools(root, changeId, 'transition tasks');
    const change = await readChange(root, changeId);
    if (!change.tasks.some(task => task.id === taskId)) throw new Error(`No task "${taskId}" in change ${changeId}.`);
    const revision = typeof args.revision === 'number' ? args.revision : (change.revision ?? 0);
    const directory = (await resolveChangeLocation(root, changeId, { scope: 'active' })).directory;
    const transitioned = await transitionTask(path.join(directory, 'tasks.json'), taskId, status as TaskStatus, revision, { force: args.force === true, requireEvidence: args.requireEvidence === true });
    const { warnings = [], ...updated } = transitioned;
    return { change: updated, warnings };
  }
  if (name === 'notchlet_verify') {
    const change = await readChange(root, changeId);
    const checkIds = stringListArg(args, 'checkIds');
    const requirementIds = stringListArg(args, 'requirementIds');
    const taskIds = stringListArg(args, 'taskIds');
    if (args.record !== true && ((requirementIds?.length ?? 0) > 0 || (taskIds?.length ?? 0) > 0)) throw new Error('requirementIds and taskIds require record=true.');
    const unknown = (checkIds ?? []).filter(checkId => !change.checks.some(check => check.id === checkId));
    if (unknown.length) throw new Error(`Unknown check ID(s): ${unknown.join(', ')}.`);
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
    const workingDirectory = typeof args.workingDirectory === 'string' ? args.workingDirectory : undefined;
    const readyTimeoutMs = typeof args.readyTimeoutMs === 'number' ? args.readyTimeoutMs : undefined;
    const readyIntervalMs = typeof args.readyIntervalMs === 'number' ? args.readyIntervalMs : undefined;
    const browser = stringArg(args, 'browser', false);
    const settleMs = nonNegativeIntegerArg(args, 'settleMs');
    const fullPage = booleanArg(args, 'fullPage');
    const viewportInput = args.viewport;
    let viewport: { width: number; height: number } | undefined;
    if (viewportInput !== undefined) {
      if (typeof viewportInput !== 'object' || viewportInput === null || Array.isArray(viewportInput)) throw new Error('viewport must be an object with width and height.');
      const { width, height } = viewportInput as Record<string, unknown>;
      if (typeof width !== 'number' || !Number.isInteger(width) || width <= 0 || typeof height !== 'number' || !Number.isInteger(height) || height <= 0) throw new Error('viewport width and height must be positive integers.');
      viewport = { width, height };
    }
    const capture = {
      ...(browser === undefined ? {} : { browser }),
      ...(viewport === undefined ? {} : { viewport }),
      ...(settleMs === undefined ? {} : { settleMs }),
      ...(fullPage === undefined ? {} : { fullPage }),
    };
    const result = await runChecks(root, change, {
      changeRef: changeId,
      ...(checkIds?.length ? { checkIds } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
      ...(readyIntervalMs === undefined ? {} : { readyIntervalMs }),
      ...(Object.keys(capture).length ? { capture } : {}),
    });
    if (result.runnable === 0) throw new Error('No runnable checks were found. Add a command to a check first.');
    const executedCheckIds = result.results.filter(check => check.status !== 'skipped').map(check => check.id);
    const failedCheckIds = result.results.filter(check => check.status === 'failed').map(check => check.id);
    const recovery = failedCheckIds.length ? verificationRecovery(changeId, failedCheckIds) : undefined;
    let evidence: Awaited<ReturnType<typeof appendEvidence>> | undefined;
    if (args.record === true) {
      const scope = resolveEvidenceScope(change, executedCheckIds, { ...(requirementIds?.length ? { requirementIds } : {}), ...(taskIds?.length ? { taskIds } : {}) });
      const log = await persistVerificationLog(root, result);
      evidence = await appendEvidence(root, changeId, {
        kind: 'check',
        outcome: result.outcome === 'failed' ? 'failed' : 'passed',
        summary: summarizeVerification(result),
        requirementIds: scope.requirementIds,
        taskIds: scope.taskIds,
        checkIds: scope.checkIds,
        provenance: 'recorded',
        ...log,
      });
    }
    return { verification: result, ...(evidence ? { evidence } : {}), ...(recovery ? { recovery } : {}) };
  }
  if (name === 'notchlet_evidence_record') {
    const kind = stringArg(args, 'kind')!;
    const outcome = stringArg(args, 'outcome')!;
    if (!['check', 'note', 'artifact'].includes(kind)) throw new Error('kind must be check, note, or artifact.');
    if (!['passed', 'failed', 'informational'].includes(outcome)) throw new Error('outcome must be passed, failed, or informational.');
    const input: EvidenceWriteInput = {
      kind: kind as EvidenceWriteInput['kind'],
      outcome: outcome as EvidenceWriteInput['outcome'],
      summary: stringArg(args, 'summary')!,
      provenance: 'recorded',
      requirementIds: stringListArg(args, 'requirementIds') ?? [],
      taskIds: stringListArg(args, 'taskIds') ?? [],
      ...(stringListArg(args, 'checkIds') ? { checkIds: stringListArg(args, 'checkIds') } : {}),
      ...(typeof args.uri === 'string' ? { uri: args.uri } : {}),
    };
    return { evidence: await appendEvidence(root, changeId, input) };
  }
  if (name === 'notchlet_evidence_list') {
    const change = await readChange(root, changeId);
    const facets = await verificationFacets(root, changeId, change);
    const filter: EvidenceFilter = {};
    if (typeof args.checkId === 'string') filter.checkId = args.checkId;
    if (typeof args.requirementId === 'string') filter.requirementId = args.requirementId;
    if (typeof args.taskId === 'string') filter.taskId = args.taskId;
    if (args.stale === true) filter.stale = true;
    if (args.failed === true) filter.failed = true;
    return { checkStatus: { missing: facets.missing, failed: facets.failed, stale: facets.stale, unknown: facets.unknown, current: facets.current }, evidence: await inspectEvidence(root, changeId, filter) };
  }
  if (name === 'notchlet_instructions') {
    const action = (args.action ?? 'resume') as WorkflowAction;
    if (!['plan', 'revise', 'implement', 'verify', 'resume'].includes(action)) throw new Error('action must be plan, revise, implement, verify, or resume.');
    const change = await readChange(root, changeId);
    const [facets, artifactState] = await Promise.all([verificationFacets(root, changeId, change), inspectChangeArtifacts(root, changeId)]);
    return { action, instructions: instructions(change, action, { artifacts: artifactState.artifacts, verification: facets }) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function createLocalMcpServer(root: string): Server {
  const server = new Server({ name: 'notchlet-local', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      return textResult(await callTool(root, request.params.name, (request.params.arguments ?? {}) as JsonObject));
    } catch (error) {
      if (error instanceof McpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return textResult(error instanceof WorkflowError ? { error: message, code: error.code, recovery: error.recovery } : { error: message }, true);
    }
  });
  return server;
}

/** Run the offline MCP server over stdio until the client closes it. */
export async function serveLocalMcp(options: LocalMcpOptions = {}): Promise<void> {
  const root = await findWorkspace(process.cwd(), options.workspace);
  if (!root) throw new Error('No initialized Notchlet workspace was found. Run `notchlet init --local` in the project root first.');
  const server = createLocalMcpServer(root);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await server.connect(transport);
  await new Promise<void>(resolve => { transport.onclose = () => resolve(); });
}
