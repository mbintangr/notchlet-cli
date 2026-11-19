import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initWorkspace, readEvidence } from '@notchlet/core';

const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
const fixtures = path.resolve('evaluation/fixtures');

function run(root: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(env.NOTCHLET_OFFLINE_PRELOAD!).href, cli, ...args, '--json'], { cwd: root, encoding: 'utf8', env });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.stdout.trim(), '', `${result.stderr}\nCLI returned no JSON output (exit ${result.status}).`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope: JSON.parse(result.stdout) };
}

for (const scenario of [
  { fixture: 'small-fix.md', name: 'Offline small fix', tasks: [{ id: 'TASK-1', title: 'Implement and test the display-label fallback', dependencies: [], requirementIds: ['REQ-1'] }] },
  { fixture: 'multi-task-story.md', name: 'Offline multi-task story', tasks: [
    { id: 'T1', title: 'Define query parameters and API validation', dependencies: [], requirementIds: ['REQ-1'] },
    { id: 'T2', title: 'Implement backend filtered query', dependencies: ['T1'], requirementIds: ['REQ-1'] },
    { id: 'T3', title: 'Add frontend filter controls and URL restoration', dependencies: ['T1'], requirementIds: ['REQ-1'] },
    { id: 'T4', title: 'Add integration and component tests', dependencies: ['T2', 'T3'], requirementIds: ['REQ-1'] },
  ] },
]) {
  test(`offline fresh-session pilot resumes ${scenario.fixture} in separate CLI processes`, async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'notchlet-offline-pilot-'));
    const root = path.join(temp, 'workspace');
    const oldConfig = process.env.NOTCHLET_CONFIG_DIR;
    const oldToken = process.env.NOTCHLET_TOKEN;
    const noNetwork = path.join(temp, 'deny-network.mjs');
    const env: NodeJS.ProcessEnv = { ...process.env, NOTCHLET_CONFIG_DIR: path.join(temp, 'config'), NOTCHLET_OFFLINE_PRELOAD: noNetwork };
    delete env.NOTCHLET_TOKEN;
    try {
      const fixture = await readFile(path.join(fixtures, scenario.fixture), 'utf8');
      assert.match(fixture, /^# Fixture:/);
      await writeFile(noNetwork, "globalThis.fetch = async () => { throw new Error('network access denied by offline pilot'); };\n");
      await initWorkspace(root);

      // Session one: create a stable change and fixture-shaped task graph.
      const created = run(root, ['change', 'new', scenario.name, '--quick'], env);
      assert.equal(created.status, 0, `${created.stderr}\n${created.stdout}`);
      const changeId = created.envelope.data.id as string;
      const taskPath = path.join(root, '.notchlet', 'changes', changeId, 'tasks.json');
      const change = JSON.parse(await readFile(taskPath, 'utf8'));
      Object.assign(change, {
        intent: fixture.replace(/\r\n/g, '\n').split('## Request\n\n')[1].split('\n')[0],
        outcome: `Satisfy acceptance checks from ${scenario.fixture}`,
        requirements: [{ id: 'REQ-1', title: 'Fixture acceptance', description: 'Meet all fixture acceptance checks.' }],
        checks: [{ id: 'CHECK-1', description: 'Run fixture acceptance checks.' }],
        tasks: scenario.tasks.map(task => ({ ...task, status: 'pending' as const })),
        revision: 1,
      });
      await writeFile(taskPath, JSON.stringify(change, null, 2));
      const firstTaskId = scenario.tasks[0].id;
      const started = run(root, ['task', 'update', changeId, firstTaskId, 'in_progress', '1'], env);
      assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`);
      const revision = started.envelope.data.revision as number;
      const completed = run(root, ['task', 'update', changeId, firstTaskId, 'completed', String(revision)], env);
      assert.equal(completed.status, 0, `${completed.stderr}\n${completed.stdout}`);
      const completedRevision = completed.envelope.data.revision as number;
      const evidenceInput = path.join(temp, 'evidence-input.json');
      await writeFile(evidenceInput, JSON.stringify({
        kind: 'check', outcome: 'passed', summary: `Verified ${firstTaskId} in offline session one`,
        requirementIds: ['REQ-1'], taskIds: [firstTaskId], checkIds: ['CHECK-1'], provenance: 'recorded',
      }));
      const recorded = run(root, ['evidence', 'record', '--change', changeId, '--file', evidenceInput], env);
      assert.equal(recorded.status, 0, `${recorded.stderr}\n${recorded.stdout}`);
      assert.deepEqual(recorded.envelope.data.checkIds, ['CHECK-1']);

      // Session two is a new Node process with networking disabled; it must recover IDs and state.
      const status = run(root, ['status', changeId], env);
      assert.equal(status.status, 0, `${status.stderr}\n${status.stdout}`);
      assert.equal(status.envelope.data.change, changeId);
      assert.equal(status.envelope.data.revision, completedRevision);
      const statePath = path.join(root, '.notchlet', 'changes', changeId, 'tasks.json');
      const recovered = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(recovered.id, changeId);
      assert.deepEqual(recovered.tasks.map((task: { id: string; status: string }) => [task.id, task.status]), scenario.tasks.map((task, index) => [task.id, index === 0 ? 'completed' : 'pending']));
      const evidence = await readEvidence(root, changeId);
      assert.equal(evidence.length, 1);
      assert.deepEqual(evidence[0].taskIds, [firstTaskId]);
      assert.equal(evidence[0].summary, `Verified ${firstTaskId} in offline session one`);
      const eligible = status.envelope.data.facets.eligibleTasks as string[];
      assert.deepEqual(eligible, scenario.tasks.slice(1).filter(task => task.dependencies.every(dep => recovered.tasks.find((entry: { id: string; status: string }) => entry.id === dep)?.status === 'completed')).map(task => task.id));
      const resume = run(root, ['instructions', changeId, '--action', 'resume'], env);
      assert.equal(resume.status, 0, `${resume.stderr}\n${resume.stdout}`);
      assert.match(resume.envelope.data.instructions, new RegExp(`Eligible tasks: ${eligible.join(', ') || 'none'}`));

      // Repeating the status read cannot mutate or lose the completed work/evidence.
      const again = run(root, ['status', changeId], env);
      assert.equal(again.status, 0, `${again.stderr}\n${again.stdout}`);
      assert.equal(again.envelope.data.revision, completedRevision);
      assert.equal((await readEvidence(root, changeId)).length, 1);
    } finally {
      if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
      if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
      await rm(temp, { recursive: true, force: true });
    }
  });
}
