import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';

const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', timeout: 90000 });
  let envelope: any;
  try { envelope = JSON.parse(result.stdout); } catch { envelope = undefined; }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope };
}

function runHuman(dir: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 90000 });
}

async function initWorkspace(dir: string): Promise<void> {
  const result = run(dir, ['init']);
  assert.equal(result.status, 0, result.stderr);
}

async function newChange(dir: string, name: string): Promise<{ id: string; file: string; change: any }> {
  const created = run(dir, ['change', 'new', name, '--quick']);
  assert.equal(created.status, 0, created.stderr);
  const id = created.envelope.data.id as string;
  const file = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');
  return { id, file, change: JSON.parse(await readFile(file, 'utf8')) };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function portIsOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('execution metadata hand edits surface as drift while change update remains clean', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-execution-v11-cli-'));
  try {
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Execution probe');
    const updated = run(dir, ['change', 'update', id,
      '--run-command', 'node server.mjs',
      '--readiness-url', 'http://127.0.0.1:3000/health',
      '--ready-timeout', '20000',
      '--environment', 'PORT=3000',
    ]);
    assert.equal(updated.status, 0, updated.stderr);

    const clean = run(dir, ['status', id]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.envelope.data.executionDrift.status, 'current');
    assert.deepEqual(clean.envelope.warnings, []);
    assert.equal(run(dir, ['change', 'render', id, '--check']).status, 0);

    const edited = { ...updated.envelope.data, runCommand: 'node -e "process.exit(0)"', readinessUrl: 'http://127.0.0.1:4499/health', readyTimeoutMs: 20000, environment: { PORT: '4499' } };
    await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);

    const drifted = run(dir, ['status', id]);
    assert.equal(drifted.status, 0, drifted.stderr);
    assert.equal(drifted.envelope.data.executionDrift.status, 'drifted');
    assert.equal(drifted.envelope.data.revision, 1, 'a hand edit does not advance the revision');
    assert.equal(drifted.envelope.warnings[0].code, 'execution_metadata_drift');
    const rendered = run(dir, ['change', 'render', id, '--check']);
    assert.equal(rendered.status, 1);
    assert.equal(rendered.envelope.data.drifted, false, 'artifact drift remains separate from execution drift');
    assert.equal(rendered.envelope.data.executionDrift.status, 'drifted');

    const shown = run(dir, ['change', 'show', id]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.envelope.data.executionDrift.status, 'drifted');
    for (const field of ['runCommand', 'readinessUrl', 'readyTimeoutMs', 'environment']) {
      assert.deepEqual(shown.envelope.data.change[field], drifted.envelope.data.execution[field], `${field} stays identical between show and status`);
    }

    const reapplied = run(dir, ['change', 'update', id,
      '--run-command', 'node -e "process.exit(0)"',
      '--readiness-url', 'http://127.0.0.1:4499/health',
      '--ready-timeout', '20000',
      '--environment', 'PORT=4499',
    ]);
    assert.equal(reapplied.status, 0, reapplied.stderr);
    const accepted = run(dir, ['status', id]);
    assert.equal(accepted.envelope.data.revision, 2);
    assert.equal(accepted.envelope.data.executionDrift.status, 'current');
    assert.deepEqual(accepted.envelope.warnings, []);
    assert.equal(run(dir, ['change', 'render', id, '--check']).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('human verification prints failure phase and blocked count', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-failure-phase-v11-cli-'));
  try {
    await initWorkspace(dir);
    const port = await freePort();
    const readiness = await newChange(dir, 'Readiness failure');
    await writeFile(readiness.file, `${JSON.stringify({
      ...readiness.change,
      runCommand: 'node -e "process.exit(5)"',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 1000,
      checks: [
        { id: 'CHECK-HTTP', description: 'Health route responds', kind: 'http', url: `http://127.0.0.1:${port}/health` },
        { id: 'CHECK-CMD', description: 'Command still runs', kind: 'command', command: 'node -e "process.exit(0)"' },
      ],
    }, null, 2)}\n`);
    const readinessHuman = runHuman(dir, ['verify', readiness.id, '--serve', '--ready-timeout', '1000']);
    assert.equal(readinessHuman.status, 1, readinessHuman.stderr);
    assert.match(readinessHuman.stdout, /Failure phase: readiness/);
    assert.match(readinessHuman.stdout, /Blocked checks: 1/);

    const checksChange = await newChange(dir, 'Check failure');
    await writeFile(checksChange.file, `${JSON.stringify({
      ...checksChange.change,
      checks: [{ id: 'CHECK-FAIL', description: 'HTTP route fails', kind: 'http', url: `http://127.0.0.1:${port}/missing`, expectedStatus: 200 }],
    }, null, 2)}\n`);
    const checksHuman = runHuman(dir, ['verify', checksChange.id]);
    assert.equal(checksHuman.status, 1, checksHuman.stderr);
    assert.match(checksHuman.stdout, /Failure phase: checks/);
    assert.doesNotMatch(checksHuman.stdout, /Blocked checks:/);

    const repeat = await newChange(dir, 'Repeat failure');
    await writeFile(repeat.file, `${JSON.stringify({
      ...repeat.change,
      checks: [{
        id: 'CHECK-UNSTABLE',
        description: 'Changes between attempts',
        kind: 'command',
        command: 'node -e "const fs=require(\'fs\');let n=0;try{n=+fs.readFileSync(\'count.txt\')}catch{};fs.writeFileSync(\'count.txt\',String(n+1));process.exit(n===0?0:1)"',
      }],
    }, null, 2)}\n`);
    const repeatHuman = runHuman(dir, ['verify', repeat.id, '--repeat', '2']);
    assert.equal(repeatHuman.status, 1, repeatHuman.stderr);
    assert.match(repeatHuman.stdout, /Failure phase: repeat/);

    const passing = await newChange(dir, 'Passing run');
    await writeFile(passing.file, `${JSON.stringify({
      ...passing.change,
      checks: [{ id: 'CHECK-PASS', description: 'Passes', kind: 'command', command: 'node -e "process.exit(0)"' }],
    }, null, 2)}\n`);
    const passingHuman = runHuman(dir, ['verify', passing.id]);
    assert.equal(passingHuman.status, 0, passingHuman.stderr);
    assert.doesNotMatch(passingHuman.stdout, /Failure phase:/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('human closure recovery suppresses planning duplicates and keeps closure-only actions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-recovery-v11-cli-'));
  try {
    await initWorkspace(dir);
    const { id } = await newChange(dir, 'Recovery probe');
    const human = runHuman(dir, ['status', id]);
    assert.equal(human.status, 0, human.stderr);
    const recoveryText = human.stdout.slice(human.stdout.indexOf('Closure recovery'));
    const bullets = recoveryText.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('•'));
    assert.ok(bullets.length > 0, recoveryText);
    const recoveries = bullets.map(line => line.replace(/^•\s*[^:]+:\s*/, ''));
    assert.equal(new Set(recoveries).size, recoveries.length, 'no duplicate recovery text is printed');
    assert.ok(bullets.some(line => line.includes('tasks_incomplete:')), 'closure-only task recovery remains');
    assert.ok(bullets.some(line => line.includes('acceptance_missing:')), 'closure-only acceptance recovery remains');
    assert.ok(!bullets.some(line => line.includes('readiness_')), 'planning readiness copies are not repeated');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('archived changes keep read-only plan provenance inspection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-archived-plan-v12-cli-'));
  try {
    await initWorkspace(dir);
    await mkdir(path.join(dir, '.notchlet', 'plans'), { recursive: true });
    const planPath = path.join(dir, '.notchlet', 'plans', 'archived.json');
    await writeFile(planPath, JSON.stringify({
      schemaVersion: 1,
      name: 'Archived plan probe',
      mode: 'quick',
      intent: 'Keep archived plan provenance inspectable',
      outcome: 'Plan status reports the archived provenance without restoring the change',
      capabilityImpact: 'none',
      capabilityRationale: 'Plan inspection is read-only and changes no shared capability.',
      evidencePolicy: 'end-of-change',
      coveragePolicy: 'strict',
      requirements: [{ id: 'REQ-1', title: 'Archived inspection', description: 'Archived plan status remains inspectable.' }],
      acceptanceScenarios: [{ id: 'SCN-1', requirementId: 'REQ-1', when: 'The change is archived', then: 'Plan status still reports provenance.' }],
      checks: [{ id: 'CHECK-1', description: 'Archived plan status is read-only', kind: 'command', command: 'node -e "process.exit(0)"', requirementIds: ['REQ-1'], scenarioIds: ['SCN-1'], taskIds: ['TASK-1'] }],
      tasks: [{ id: 'TASK-1', title: 'Archive the change', dependencies: [], requirementIds: ['REQ-1'] }],
    }, null, 2));
    const imported = run(dir, ['change', 'new', 'Archived plan probe', '--from', planPath, '--quick']);
    assert.equal(imported.status, 0, imported.stderr);
    const id = imported.envelope.data.id as string;

    const active = run(dir, ['change', 'plan', 'status', id]);
    assert.equal(active.status, 0, active.stderr);
    assert.equal(active.envelope.data.archived, undefined);

    assert.equal(run(dir, ['task', 'complete', '--all', '--change', id]).status, 0);
    const verified = run(dir, ['verify', id, '--record']);
    assert.equal(verified.status, 0, verified.stderr);
    const closed = run(dir, ['change', 'close', id]);
    assert.equal(closed.status, 0, closed.stdout);

    const archived = run(dir, ['change', 'plan', 'status', id]);
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(archived.envelope.data.archived, true);
    assert.equal(archived.envelope.data.plan.drift.status, 'none');
    assert.equal(archived.envelope.data.plan.recordedSha256, active.envelope.data.plan.recordedSha256);
    assert.equal(archived.envelope.data.plan.currentSha256, active.envelope.data.plan.currentSha256);
    assert.equal(archived.envelope.data.plan.contractSha256, active.envelope.data.plan.contractSha256);
    assert.match(archived.envelope.data.plan.recordedSha256, /^[a-f0-9]{64}$/);

    const archivedStatus = run(dir, ['status', id]);
    assert.equal(archivedStatus.status, 0, archivedStatus.stderr);
    assert.equal(archivedStatus.envelope.data.archived, true);
    assert.equal(archivedStatus.envelope.data.plan.recordedSha256, archived.envelope.data.plan.recordedSha256);
    assert.equal(archivedStatus.envelope.data.plan.currentSha256, archived.envelope.data.plan.currentSha256);
    assert.equal(archivedStatus.envelope.data.closure.plan.recordedSha256, archived.envelope.data.plan.recordedSha256);
    assert.equal(archivedStatus.envelope.data.closure.plan.acceptedDrift, false);

    const rejectedSync = run(dir, ['change', 'plan', 'sync', id]);
    assert.equal(rejectedSync.status, 1);
    assert.equal(rejectedSync.envelope.error.code, 'archived_change');
    assert.match(rejectedSync.envelope.error.recovery, /change plan status/);

    const human = runHuman(dir, ['change', 'plan', 'status', id]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Plan provenance: .* \(archived\)/);
    assert.match(human.stdout, /Archived: yes/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('served app process tree stops after verification', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-serve-cleanup-v12-cli-'));
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'server.mjs'), `import { createServer } from 'node:http';
createServer((_request, response) => {
  response.statusCode = 200;
  response.end('ok');
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await initWorkspace(dir);
    const { id } = await newChange(dir, 'Serve cleanup');
    const updated = run(dir, ['change', 'update', id,
      '--run-command', 'node server.mjs',
      '--readiness-url', `http://127.0.0.1:${port}/health`,
      '--ready-timeout', '5000',
      '--environment', `PORT=${port}`,
    ]);
    assert.equal(updated.status, 0, updated.stderr);
    const added = run(dir, ['change', 'add', id, 'check', '--id', 'CHECK-1', '--description', 'Command passes', '--command', 'node -e "process.exit(0)"']);
    assert.equal(added.status, 0, added.stderr);

    const verified = run(dir, ['verify', id, '--check', 'CHECK-1', '--serve', '--ready-timeout', '5000']);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);

    let open = true;
    for (let attempt = 0; attempt < 20 && open; attempt++) {
      open = await portIsOpen(port);
      if (open) await delay(100);
    }
    assert.equal(open, false, 'the served app must be stopped after verification');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('plan status exposes recorded and current hashes in live and plan views', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-plan-hash-v11-cli-'));
  try {
    await initWorkspace(dir);
    await mkdir(path.join(dir, '.notchlet', 'plans'), { recursive: true });
    const planPath = path.join(dir, '.notchlet', 'plans', 'feature.json');
    await writeFile(planPath, JSON.stringify({ intent: 'Plan intent', outcome: 'Plan outcome' }, null, 2));
    const imported = run(dir, ['change', 'new', 'Plan hash probe', '--from', planPath, '--quick']);
    assert.equal(imported.status, 0, imported.stderr);
    const id = imported.envelope.data.id as string;

    const clean = run(dir, ['change', 'plan', 'status', id]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.envelope.data.plan.recordedSha256, /^[a-f0-9]{64}$/);
    assert.equal(clean.envelope.data.plan.recordedSha256, clean.envelope.data.plan.currentSha256);
    const live = run(dir, ['status', id]);
    assert.equal(live.envelope.data.plan.recordedSha256, clean.envelope.data.plan.recordedSha256);

    await writeFile(planPath, `${JSON.stringify({ intent: 'Changed intent', outcome: 'Plan outcome' }, null, 2)}\n`);
    const drifted = run(dir, ['change', 'plan', 'status', id]);
    assert.equal(drifted.status, 0, drifted.stderr);
    assert.equal(drifted.envelope.data.plan.drift.status, 'drifted');
    assert.notEqual(drifted.envelope.data.plan.recordedSha256, drifted.envelope.data.plan.currentSha256);
    assert.equal(drifted.envelope.data.plan.recordedSha256, clean.envelope.data.plan.recordedSha256);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
