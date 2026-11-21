import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('authoring integrity covers batch apply, item edits, strict options, revisions, and rendered artifacts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-authoring-integrity-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 20000 });
  try {
    assert.equal(run(['init', '--local']).status, 0);
    const created = run(['change', 'new', 'Authoring integrity', '--json']);
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).data.id as string;
    const tasksFile = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');

    const batchFile = path.join(dir, 'plan.json');
    const writeBatch = async (value: unknown) => { await writeFile(batchFile, typeof value === 'string' ? value : JSON.stringify(value)); };
    await writeBatch({
      expectedRevision: 0,
      operations: [
        { op: 'field', intent: 'Author atomically', outcome: 'Linked items land in one write', capabilityImpact: 'none', capabilityRationale: 'No durable capability change.' },
        { op: 'add', kind: 'requirement', id: 'REQ-1', title: 'Batch authoring', description: 'Items link in any order.' },
        { op: 'add', kind: 'check', id: 'CHECK-1', description: 'Verify batch', command: 'node --version', requirementIds: ['REQ-1'], taskIds: ['TASK-1'] },
        { op: 'add', kind: 'task', id: 'TASK-1', title: 'Implement batch', requirementIds: ['REQ-1'] },
        { op: 'add', kind: 'scenario', id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'A batch runs', then: 'Links resolve' },
        { op: 'add', kind: 'decision', id: 'DECISION-1', decision: 'Validate at the end', rationale: 'Order independence' },
      ],
    });
    const applied = run(['change', 'apply', id, '--file', batchFile, '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedData = JSON.parse(applied.stdout).data;
    assert.equal(appliedData.applied, 6);
    assert.equal(appliedData.change.revision, 1);
    assert.deepEqual(appliedData.change.checks[0].taskIds, ['TASK-1']);

    const humanShow = run(['change', 'show', id]);
    assert.equal(humanShow.status, 0);
    assert.match(humanShow.stdout, /Scenarios/);
    assert.match(humanShow.stdout, /SCENARIO-1 \[scenario\] WHEN A batch runs THEN Links resolve/);
    assert.match(humanShow.stdout, /DECISION-1 \[decision\] Validate at the end/);
    assert.match(humanShow.stdout, /verifies requirements REQ-1; tasks TASK-1/);
    assert.match(humanShow.stdout, /implements REQ-1/);
    assert.match(humanShow.stdout, /Baseline revision/);

    const edited = run(['change', 'update', id, 'requirement', 'REQ-1', '--title', 'Batch authoring v2', '--json']);
    assert.equal(edited.status, 0, edited.stderr);
    assert.equal(JSON.parse(edited.stdout).data.revision, 2);
    const shownAfterEdit = JSON.parse(run(['change', 'show', id, '--json']).stdout).data.change;
    assert.equal(shownAfterEdit.requirements[0].title, 'Batch authoring v2');
    assert.equal(shownAfterEdit.requirements[0].description, 'Items link in any order.');

    const checkEdit = run(['change', 'update', id, 'check', 'CHECK-1', '--command', 'node --version', '--requirement', 'REQ-1', '--task', 'TASK-1', '--json']);
    assert.equal(checkEdit.status, 0, checkEdit.stderr);
    const shownAfterCheck = JSON.parse(run(['change', 'show', id, '--json']).stdout).data.change;
    assert.equal(shownAfterCheck.revision, 3);
    assert.deepEqual(shownAfterCheck.checks[0].taskIds, ['TASK-1']);
    assert.equal(shownAfterCheck.checks[0].description, 'Verify batch');

    const beforeStrict = JSON.parse(await readFile(tasksFile, 'utf8'));
    const unknownOption = run(['change', 'update', id, 'requirement', 'REQ-1', '--bogus', 'x', '--json']);
    assert.equal(unknownOption.status, 64);
    assert.equal(JSON.parse(unknownOption.stdout).error.code, 'usage_error');
    const inapplicable = run(['change', 'update', id, 'requirement', 'REQ-1', '--command', 'echo', '--json']);
    assert.equal(inapplicable.status, 64);
    assert.match(JSON.parse(inapplicable.stdout).error.message, /Unsupported option --command/);
    const badAddOption = run(['change', 'add', id, 'requirement', '--id', 'REQ-9', '--title', 'T', '--description', 'D', '--when', 'x', '--json']);
    assert.equal(badAddOption.status, 64);
    const bothRenderModes = run(['change', 'render', id, '--check', '--write', '--json']);
    assert.equal(bothRenderModes.status, 64);
    const afterStrict = JSON.parse(await readFile(tasksFile, 'utf8'));
    assert.equal(afterStrict.revision, beforeStrict.revision);
    assert.equal(afterStrict.requirements.length, 1);

    const humanConflict = run(['change', 'update', id, '--intent', 'Stale', '--revision', '0']);
    assert.equal(humanConflict.status, 1);
    assert.match(humanConflict.stderr, /revision_conflict/);
    const jsonConflict = run(['change', 'update', id, '--intent', 'Stale', '--revision', '0', '--json']);
    assert.equal(jsonConflict.status, 1);
    assert.equal(JSON.parse(jsonConflict.stdout).error.code, 'revision_conflict');
    assert.equal(JSON.parse(await readFile(tasksFile, 'utf8')).intent, 'Author atomically');

    await writeBatch({ expectedRevision: 0, operations: [{ op: 'field', intent: 'Stale batch' }] });
    const batchConflict = run(['change', 'apply', id, '--file', batchFile, '--json']);
    assert.equal(batchConflict.status, 1);
    assert.equal(JSON.parse(batchConflict.stdout).error.code, 'revision_conflict');
    await writeBatch({ expectedRevision: 0, operations: [{ op: 'field', intent: 'Precedence wins' }] });
    const precedence = run(['change', 'apply', id, '--file', batchFile, '--revision', '3', '--json']);
    assert.equal(precedence.status, 0, precedence.stderr);
    assert.equal(JSON.parse(precedence.stdout).data.change.intent, 'Precedence wins');
    assert.equal(JSON.parse(precedence.stdout).data.change.revision, 4);

    await writeBatch({
      expectedRevision: 4,
      operations: [
        { op: 'add', kind: 'requirement', id: 'REQ-2', title: 'Rolled back', description: 'Must not persist' },
        { op: 'add', kind: 'scenario', id: 'SCENARIO-2', requirementId: 'REQ-404', when: 'Broken', then: 'Never' },
      ],
    });
    const rolledBack = run(['change', 'apply', id, '--file', batchFile, '--json']);
    assert.equal(rolledBack.status, 1);
    assert.equal(JSON.parse(rolledBack.stdout).error.code, 'unknown_scenario_requirement');
    const afterRollback = JSON.parse(await readFile(tasksFile, 'utf8'));
    assert.equal(afterRollback.revision, 4);
    assert.equal(afterRollback.requirements.length, 1);
    await writeBatch('{ not json');
    const invalidJson = run(['change', 'apply', id, '--file', batchFile, '--json']);
    assert.equal(invalidJson.status, 2);
    assert.equal(JSON.parse(invalidJson.stdout).error.code, 'invalid_input');
    await writeBatch({ expectedRevision: 4, operations: [], extra: true });
    const unsupportedField = run(['change', 'apply', id, '--file', batchFile, '--json']);
    assert.equal(unsupportedField.status, 64);
    assert.match(JSON.parse(unsupportedField.stdout).error.message, /Unsupported batch field extra/);

    const drifting = run(['change', 'render', id, '--check', '--json']);
    assert.equal(drifting.status, 1);
    const driftData = JSON.parse(drifting.stdout).data;
    assert.equal(driftData.drifted, true);
    assert.ok(driftData.artifacts.filter((artifact: any) => artifact.role === 'rendered' || artifact.role === 'canonical').every((artifact: any) => artifact.status === 'drifted'));
    const written = run(['change', 'render', id, '--write', '--json']);
    assert.equal(written.status, 0, written.stderr);
    const writtenData = JSON.parse(written.stdout).data;
    assert.deepEqual(writtenData.written, ['proposal.json', 'spec.json']);
    assert.equal(writtenData.change.revision, 5);
    assert.equal(run(['change', 'render', id, '--check', '--json']).status, 0);

    const markdown = run(['change', 'render', id, '--write', '--markdown', '--json']);
    assert.equal(markdown.status, 0, markdown.stderr);
    const markdownData = JSON.parse(markdown.stdout).data;
    assert.deepEqual(markdownData.written, ['proposal.md', 'spec.md', 'tasks.md']);
    assert.equal(markdownData.change.revision, 6);

    await writeFile(path.join(dir, '.notchlet', 'changes', id, 'proposal.md'), 'hand-authored content\n');
    const refused = run(['change', 'render', id, '--write', '--json']);
    assert.equal(refused.status, 1);
    const refusedData = JSON.parse(refused.stdout).data;
    assert.deepEqual(refusedData.written, []);
    assert.match(refusedData.refused[0].reason, /generated-content marker/);
    assert.equal(refusedData.change.revision, 6);
    const forced = run(['change', 'render', id, '--write', '--force', '--json']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(JSON.parse(forced.stdout).data.written, ['proposal.md']);
    assert.equal(JSON.parse(forced.stdout).data.change.revision, 7);
    assert.equal(run(['change', 'render', id, '--check', '--json']).status, 0);

    const addConflict = run(['change', 'add', id, 'requirement', '--id', 'REQ-2', '--title', 'Two', '--description', 'Two', '--revision', '0', '--json']);
    assert.equal(addConflict.status, 1);
    assert.equal(JSON.parse(addConflict.stdout).error.code, 'revision_conflict');
    const added = run(['change', 'add', id, 'requirement', '--id', 'REQ-2', '--title', 'Two', '--description', 'Two', '--revision', '7', '--json']);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).data.revision, 8);
    const removeConflict = run(['change', 'remove', id, 'requirement', 'REQ-2', '--revision', '0', '--json']);
    assert.equal(removeConflict.status, 1);
    assert.equal(JSON.parse(removeConflict.stdout).error.code, 'revision_conflict');
    assert.ok(JSON.parse(await readFile(tasksFile, 'utf8')).requirements.some((requirement: any) => requirement.id === 'REQ-2'));

    const convertConflict = run(['change', 'convert', id, '--schema', 'quick', '--revision', '0', '--json']);
    assert.equal(convertConflict.status, 1);
    assert.equal(JSON.parse(convertConflict.stdout).error.code, 'revision_conflict');
    assert.equal(JSON.parse(await readFile(tasksFile, 'utf8')).mode, 'standard');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
