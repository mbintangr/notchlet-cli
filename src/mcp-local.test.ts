import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initWorkspace } from '@notchlet/core';
import { createLocalMcpServer, localToolDefinitions } from './mcp-local.js';

async function connect(root: string) {
  const server = createLocalMcpServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'notchlet-local-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find(item => item.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

test('offline MCP server authors, verifies, and records evidence without an account or remote server', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-local-mcp-'));
  const { client, close } = await connect(dir);
  try {
    await initWorkspace(dir);
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);
    for (const name of ['notchlet_change_create', 'notchlet_change_add', 'notchlet_change_render', 'notchlet_task_transition', 'notchlet_verify', 'notchlet_evidence_record']) assert.ok(names.includes(name), name);

    const created = payload(await client.callTool({ name: 'notchlet_change_create', arguments: { name: 'Local MCP flow', mode: 'quick' } })) as any;
    const id = created.change.id as string;

    const inspected = payload(await client.callTool({ name: 'notchlet_change_render', arguments: { changeId: id } })) as any;
    assert.equal(inspected.drifted, false);
    assert.deepEqual(inspected.artifacts.map((artifact: any) => artifact.artifact), ['proposal.json', 'tasks.json']);
    const noop = payload(await client.callTool({ name: 'notchlet_change_render', arguments: { changeId: id, write: true } })) as any;
    assert.deepEqual(noop.written, []);
    assert.deepEqual(noop.unchanged, ['proposal.json']);
    assert.equal(noop.change.revision, 0);
    payload(await client.callTool({ name: 'notchlet_change_update', arguments: { changeId: id, outcome: 'Render after a model edit' } }));
    const rendered = payload(await client.callTool({ name: 'notchlet_change_render', arguments: { changeId: id, write: true } })) as any;
    assert.deepEqual(rendered.written, ['proposal.json']);
    assert.equal(rendered.change.revision, 2);
    const markdown = payload(await client.callTool({ name: 'notchlet_change_render', arguments: { changeId: id, write: true, markdown: true } })) as any;
    assert.deepEqual(markdown.written, ['proposal.md', 'tasks.md']);

    payload(await client.callTool({ name: 'notchlet_change_update', arguments: {
      changeId: id, intent: 'Prove the local MCP loop works', outcome: 'Checks pass and evidence is recorded',
      capabilityImpact: 'none', capabilityRationale: 'Test-only flow with no durable capability change.',
    } }));
    payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'requirement', id: 'REQ-1', title: 'Local flow', description: 'Agents can author locally.' } }));
    payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'check', id: 'CHECK-1', description: 'Node is available', command: 'node --version' } }));
    payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'task', id: 'TASK-1', title: 'Run the local loop', requirementIds: ['REQ-1'] } }));

    const premature = await client.callTool({ name: 'notchlet_task_transition', arguments: { changeId: id, taskId: 'TASK-1', status: 'completed' } });
    assert.equal(premature.isError, true);
    assert.match(payload(premature).error, /cannot move from pending to completed/);

    payload(await client.callTool({ name: 'notchlet_task_transition', arguments: { changeId: id, taskId: 'TASK-1', status: 'in_progress' } }));
    payload(await client.callTool({ name: 'notchlet_task_transition', arguments: { changeId: id, taskId: 'TASK-1', status: 'completed' } }));

    const verified = payload(await client.callTool({ name: 'notchlet_verify', arguments: { changeId: id, record: true } })) as any;
    assert.equal(verified.verification.outcome, 'passed');
    assert.equal(verified.evidence.checkIds[0], 'CHECK-1');
    assert.match(verified.evidence.logPath, /^evidence\/logs\/[^/]+\.json$/);
    assert.match(verified.evidence.logHash, /^[0-9a-f]{64}$/);
    assert.ok(verified.evidence.logBytes > 0);

    const evidence = payload(await client.callTool({ name: 'notchlet_evidence_list', arguments: { changeId: id } })) as any;
    assert.equal(evidence.evidence.length, 1);
    assert.equal(evidence.checkStatus.current[0], 'CHECK-1');
    assert.deepEqual(evidence.checkStatus.unknown, []);
    assert.equal(evidence.evidence[0].freshness.status, 'fresh');
    assert.equal(evidence.evidence[0].freshness.basis, 'artifact');

    const status = payload(await client.callTool({ name: 'notchlet_workspace_status', arguments: { changeId: id } })) as any;
    assert.equal(status.change.id, id);
    assert.equal(status.state.execution.status, 'completed');
    assert.equal(status.readiness.ready, true, JSON.stringify(status.readiness.blockers));
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('offline MCP scopes verify evidence, exposes filters, and enforces strict completion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-local-mcp-evidence-'));
  const { client, close } = await connect(dir);
  try {
    await initWorkspace(dir);
    const created = payload(await client.callTool({ name: 'notchlet_change_create', arguments: { name: 'MCP evidence integrity', mode: 'quick' } })) as any;
    const id = created.change.id as string;
    for (const requirement of ['REQ-1', 'REQ-2']) payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'requirement', id: requirement, title: requirement, description: `Behavior ${requirement}` } }));
    for (const [task, requirement] of [['TASK-1', 'REQ-1'], ['TASK-2', 'REQ-2']]) payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'task', id: task, title: task, requirementIds: [requirement] } }));
    for (const [check, requirement, task] of [['CHECK-1', 'REQ-1', 'TASK-1'], ['CHECK-2', 'REQ-2', 'TASK-2']]) {
      payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'check', id: check, description: `Run ${check}`, command: 'node --version', requirementIds: [requirement], taskIds: [task] } }));
    }
    const rejected = await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'check', id: 'CHECK-BAD', description: 'Bad link', requirementIds: ['REQ-9'] } });
    assert.equal(rejected.isError, true);
    assert.match(payload(rejected).error, /unknown requirement/);
    const shown = payload(await client.callTool({ name: 'notchlet_change_get', arguments: { changeId: id } })) as any;
    assert.deepEqual(shown.change.checks.find((check: any) => check.id === 'CHECK-1').requirementIds, ['REQ-1']);
    assert.deepEqual(shown.change.checks.find((check: any) => check.id === 'CHECK-1').taskIds, ['TASK-1']);

    const noRecord = await client.callTool({ name: 'notchlet_verify', arguments: { changeId: id, requirementIds: ['REQ-1'] } });
    assert.equal(noRecord.isError, true);
    assert.match(payload(noRecord).error, /require record=true/);
    const scoped = payload(await client.callTool({ name: 'notchlet_verify', arguments: { changeId: id, checkIds: ['CHECK-1'], record: true } })) as any;
    assert.deepEqual(scoped.evidence.checkIds, ['CHECK-1']);
    assert.deepEqual(scoped.evidence.requirementIds, ['REQ-1']);
    assert.deepEqual(scoped.evidence.taskIds, ['TASK-1']);

    payload(await client.callTool({ name: 'notchlet_change_update', arguments: { changeId: id, outcome: 'Checks pass after revising the outcome' } }));

    payload(await client.callTool({ name: 'notchlet_task_transition', arguments: { changeId: id, taskId: 'TASK-2', status: 'in_progress' } }));
    const strict = await client.callTool({ name: 'notchlet_task_transition', arguments: { changeId: id, taskId: 'TASK-2', status: 'completed', requireEvidence: true } });
    assert.equal(strict.isError, true);
    assert.equal(payload(strict).code, 'evidence_required');
    assert.match(payload(strict).recovery, /--task TASK-2/);
    const unchanged = payload(await client.callTool({ name: 'notchlet_change_get', arguments: { changeId: id } })) as any;
    assert.equal(unchanged.change.tasks.find((task: any) => task.id === 'TASK-2').status, 'in_progress');

    const warned = payload(await client.callTool({ name: 'notchlet_task_transition', arguments: { changeId: id, taskId: 'TASK-2', status: 'completed' } })) as any;
    assert.equal(warned.change.tasks.find((task: any) => task.id === 'TASK-2').status, 'completed');
    assert.equal(warned.warnings[0].code, 'evidence_missing');
    assert.equal(warned.warnings[0].evidenceStatus, 'missing');

    const filtered = async (args: Record<string, unknown>) => (payload(await client.callTool({ name: 'notchlet_evidence_list', arguments: { changeId: id, ...args } })) as any).evidence as any[];
    assert.equal((await filtered({ checkId: 'CHECK-1' })).length, 1);
    assert.equal((await filtered({ requirementId: 'REQ-1' })).length, 1);
    assert.equal((await filtered({ taskId: 'TASK-1' })).length, 1);
    assert.equal((await filtered({ taskId: 'TASK-2' })).length, 0);
    assert.equal((await filtered({ failed: true })).length, 0);
    const stale = await filtered({ stale: true });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].freshness.status, 'stale');
    assert.match(stale[0].recovery, /notchlet verify/);
    const status = payload(await client.callTool({ name: 'notchlet_change_get', arguments: { changeId: id } })) as any;
    assert.match(status.recovery, /notchlet verify/);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('offline MCP server captures baselines and authors revision-checked delta operations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-local-mcp-delta-'));
  const { client, close } = await connect(dir);
  try {
    await initWorkspace(dir);
    const created = payload(await client.callTool({ name: 'notchlet_change_create', arguments: { name: 'MCP delta', mode: 'quick' } })) as any;
    const id = created.change.id as string;
    payload(await client.callTool({ name: 'notchlet_change_update', arguments: { changeId: id, capabilityImpact: 'delta', capabilityRationale: 'Adds durable behavior.' } }));
    payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'requirement', id: 'REQ-D', title: 'Delta', description: 'Durable behavior.' } }));
    payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'scenario', id: 'SCENARIO-D', requirementId: 'REQ-D', when: 'Used', then: 'Available' } }));

    const captured = payload(await client.callTool({ name: 'notchlet_change_baseline', arguments: { changeId: id, capabilityName: 'mcp-capability', revision: 3 } })) as any;
    assert.equal(captured.baselineRevision, 0);
    assert.equal(captured.change.revision, 4);
    assert.equal(captured.change.capabilityName, 'mcp-capability');

    const stale = await client.callTool({ name: 'notchlet_change_baseline', arguments: { changeId: id, capabilityName: 'mcp-capability', revision: 1 } });
    assert.equal(stale.isError, true);
    assert.match(payload(stale).error, /Revision conflict/i);

    const authored = payload(await client.callTool({ name: 'notchlet_change_delta', arguments: { changeId: id, operation: 'add', requirementId: 'REQ-D', rationale: 'Declare the new behavior.', revision: 4 } })) as any;
    assert.equal(authored.change.revision, 5);
    assert.deepEqual(authored.change.capabilityDelta.operations[0].requirement, { id: 'REQ-D', title: 'Delta', description: 'Durable behavior.' });
    assert.equal(authored.change.capabilityDelta.operations[0].scenarios[0].id, 'SCENARIO-D');

    const duplicate = await client.callTool({ name: 'notchlet_change_delta', arguments: { changeId: id, operation: 'update', requirementId: 'REQ-D', rationale: 'Duplicate.' } });
    assert.equal(duplicate.isError, true);
    assert.match(payload(duplicate).error, /already contains requirement/i);

    const deleted = payload(await client.callTool({ name: 'notchlet_change_delta', arguments: { changeId: id, operation: 'delete', requirementId: 'REQ-D', revision: 5 } })) as any;
    assert.deepEqual(deleted.change.capabilityDelta.operations, []);
    assert.equal(deleted.change.revision, 6);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('local MCP tool descriptions state the implemented removal and verification scope', () => {
  const remove = localToolDefinitions.find(tool => tool.name === 'notchlet_change_remove');
  assert.ok(remove);
  assert.match(remove.description, /Checks referenced by recorded evidence are protected\./);
  assert.doesNotMatch(remove.description, /Items referenced by evidence/);

  const verify = localToolDefinitions.find(tool => tool.name === 'notchlet_verify');
  assert.ok(verify);
  assert.match(verify.description, /executed checks/);
  assert.match(verify.description, /declared or explicitly selected requirement\/task links/);
});
