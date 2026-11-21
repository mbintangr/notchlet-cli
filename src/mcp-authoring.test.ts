import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initWorkspace } from '@notchlet/core';
import { createLocalMcpServer } from './mcp-local.js';

async function connect(root: string) {
  const server = createLocalMcpServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'notchlet-local-authoring-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find(item => item.type === 'text')?.text ?? '{}');
}

test('offline MCP edits items, enforces revisions, and applies the same batches as the CLI', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-mcp-authoring-'));
  const { client, close } = await connect(dir);
  try {
    await initWorkspace(dir);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes('notchlet_change_apply'), 'notchlet_change_apply');

    const created = payload(await client.callTool({ name: 'notchlet_change_create', arguments: { name: 'MCP authoring', mode: 'quick' } })) as any;
    const id = created.change.id as string;
    payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'requirement', id: 'REQ-1', title: 'Original', description: 'Original description' } }));
    payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'task', id: 'TASK-1', title: 'Task', requirementIds: ['REQ-1'] } }));
    payload(await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'check', id: 'CHECK-1', description: 'Check', command: 'node --version', requirementIds: ['REQ-1'], taskIds: ['TASK-1'] } }));

    const edited = payload(await client.callTool({ name: 'notchlet_change_update', arguments: { changeId: id, kind: 'requirement', itemId: 'REQ-1', title: 'Renamed', revision: 3 } })) as any;
    assert.equal(edited.change.revision, 4);
    assert.equal(edited.change.requirements[0].title, 'Renamed');
    assert.equal(edited.change.requirements[0].description, 'Original description');

    const checkEdit = payload(await client.callTool({ name: 'notchlet_change_update', arguments: { changeId: id, kind: 'check', itemId: 'CHECK-1', command: 'node -e "process.exit(0)"' } })) as any;
    assert.equal(checkEdit.change.revision, 5);
    assert.equal(checkEdit.change.checks[0].description, 'Check');
    assert.deepEqual(checkEdit.change.checks[0].requirementIds, ['REQ-1']);
    assert.deepEqual(checkEdit.change.checks[0].taskIds, ['TASK-1']);

    const inapplicable = await client.callTool({ name: 'notchlet_change_update', arguments: { changeId: id, kind: 'requirement', itemId: 'REQ-1', command: 'echo' } });
    assert.equal(inapplicable.isError, true);
    assert.match(payload(inapplicable).error, /do not support the "command" field/);

    const staleEdit = await client.callTool({ name: 'notchlet_change_update', arguments: { changeId: id, kind: 'requirement', itemId: 'REQ-1', title: 'Stale', revision: 0 } });
    assert.equal(staleEdit.isError, true);
    assert.equal(payload(staleEdit).code, 'revision_conflict');

    const staleAdd = await client.callTool({ name: 'notchlet_change_add', arguments: { changeId: id, kind: 'decision', id: 'DECISION-1', decision: 'd', rationale: 'r', revision: 0 } });
    assert.equal(staleAdd.isError, true);
    assert.equal(payload(staleAdd).code, 'revision_conflict');

    const batch = [
      { op: 'add', kind: 'requirement', id: 'REQ-2', title: 'Batch', description: 'Batch requirement' },
      { op: 'add', kind: 'task', id: 'TASK-2', title: 'Batch task', requirementIds: ['REQ-2'] },
      { op: 'add', kind: 'check', id: 'CHECK-2', description: 'Batch check', command: 'node --version', requirementIds: ['REQ-2'], taskIds: ['TASK-2'] },
      { op: 'add', kind: 'scenario', id: 'SCENARIO-1', requirementId: 'REQ-2', when: 'MCP batch runs', then: 'Links resolve' },
      { op: 'update', kind: 'requirement', id: 'REQ-1', title: 'Renamed again' },
    ];
    const applied = payload(await client.callTool({ name: 'notchlet_change_apply', arguments: { changeId: id, revision: 5, operations: batch } })) as any;
    assert.equal(applied.applied, 5);
    assert.equal(applied.change.revision, 6);
    assert.equal(applied.change.requirements.find((item: any) => item.id === 'REQ-1').title, 'Renamed again');
    assert.deepEqual(applied.change.checks.find((item: any) => item.id === 'CHECK-2').taskIds, ['TASK-2']);
    assert.equal(applied.change.acceptanceScenarios.find((item: any) => item.id === 'SCENARIO-1').requirementId, 'REQ-2');

    const staleApply = await client.callTool({ name: 'notchlet_change_apply', arguments: { changeId: id, revision: 5, operations: batch } });
    assert.equal(staleApply.isError, true);
    assert.equal(payload(staleApply).code, 'revision_conflict');

    const rolledBack = await client.callTool({ name: 'notchlet_change_apply', arguments: { changeId: id, operations: [
      { op: 'add', kind: 'requirement', id: 'REQ-3', title: 'Rolled back', description: 'Must not persist' },
      { op: 'add', kind: 'scenario', id: 'SCENARIO-2', requirementId: 'REQ-404', when: 'Broken', then: 'Never' },
    ] } });
    assert.equal(rolledBack.isError, true);
    assert.equal(payload(rolledBack).code, 'unknown_scenario_requirement');

    const deltaBatch = await client.callTool({ name: 'notchlet_change_apply', arguments: { changeId: id, operations: [{ op: 'delta', requirementId: 'REQ-1' }] } });
    assert.equal(deltaBatch.isError, true);
    assert.equal(payload(deltaBatch).code, 'invalid_schema');

    const after = payload(await client.callTool({ name: 'notchlet_change_get', arguments: { changeId: id } })) as any;
    assert.equal(after.change.revision, 6);
    assert.deepEqual(after.change.requirements.map((item: any) => item.id), ['REQ-1', 'REQ-2']);
    assert.equal(after.change.tasks.find((task: any) => task.id === 'TASK-1').requirementIds[0], 'REQ-1');

    const staleRemove = await client.callTool({ name: 'notchlet_change_remove', arguments: { changeId: id, kind: 'check', itemId: 'CHECK-2', revision: 0 } });
    assert.equal(staleRemove.isError, true);
    assert.equal(payload(staleRemove).code, 'revision_conflict');
    const removed = payload(await client.callTool({ name: 'notchlet_change_remove', arguments: { changeId: id, kind: 'check', itemId: 'CHECK-2', revision: 6 } }));
    assert.equal(removed.change.revision, 7);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
