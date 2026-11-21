import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendEvidence } from '@notchlet/core';

const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
  let envelope: any;
  try { envelope = JSON.parse(result.stdout); } catch { envelope = undefined; }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope };
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

async function saveChange(file: string, change: any): Promise<void> {
  await writeFile(file, `${JSON.stringify(change, null, 2)}\n`);
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

async function startServer(dir: string, script: string, children: Array<ReturnType<typeof spawn>>): Promise<void> {
  const child = spawn(process.execPath, [script], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server ${script} did not report ready`)), 15000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready')) { clearTimeout(timer); resolve(); }
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`server ${script} exited early with ${code}`)));
  });
}

async function stopServers(children: Array<ReturnType<typeof spawn>>): Promise<void> {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    child.kill();
    await once(child, 'exit').catch(() => undefined);
  }
}

test('repeat distinguishes observation drift under identical failures from a deterministic failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-repeat-v8-'));
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'counter-server.mjs'), `import { createServer } from 'node:http';
let count = 2;
const server = createServer((request, response) => {
  if (request.url === '/fixed') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ count: 4 }));
    return;
  }
  count += 2;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ count }));
});
server.listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    await startServer(dir, 'counter-server.mjs', children);
    await initWorkspace(dir);

    const drift = await newChange(dir, 'Drifting failure');
    await saveChange(drift.file, {
      ...drift.change,
      checks: [{ id: 'CHECK-POSTS', description: 'Post count matches', kind: 'http', url: `http://127.0.0.1:${port}/posts`, expectedStatus: 200, expectedJson: { count: 3 } }],
    });
    const drifted = run(dir, ['verify', drift.id, '--check', 'CHECK-POSTS', '--repeat', '2', '--setup', 'node -e "console.log(\'seed\')"']);
    assert.equal(drifted.status, 1, `${drifted.stdout}\n${drifted.stderr}`);
    const driftVerification = drifted.envelope.data.verification;
    assert.equal(driftVerification.outcome, 'failed');
    assert.equal(driftVerification.repeat.stable, false);
    assert.equal(driftVerification.repeat.code, 'state_drift_under_stable_failure');
    assert.deepEqual(driftVerification.repeat.differing, []);
    assert.equal(driftVerification.repeat.drifting.length, 1);
    assert.equal(driftVerification.repeat.drifting[0].checkId, 'CHECK-POSTS');
    assert.equal(driftVerification.repeat.outcomes.length, 2);
    const observations = driftVerification.repeat.outcomes.map((outcome: any) => outcome.checks[0].observation);
    assert.match(observations[0], /observed 4/);
    assert.match(observations[1], /observed 6/);
    assert.match(driftVerification.results[0].hints.join(' '), /observed failure changed/);
    assert.match(driftVerification.results[0].hints.join(' '), /Setup ran before each attempt/);
    assert.equal(driftVerification.repeat.setupRan, true);
    assert.match(driftVerification.repeat.hints.join(' '), /observed failure changed/);

    const deterministic = await newChange(dir, 'Deterministic failure');
    await saveChange(deterministic.file, {
      ...deterministic.change,
      checks: [{ id: 'CHECK-POSTS', description: 'Post count matches', kind: 'http', url: `http://127.0.0.1:${port}/fixed`, expectedStatus: 200, expectedJson: { count: 3 } }],
    });
    const stable = run(dir, ['verify', deterministic.id, '--check', 'CHECK-POSTS', '--repeat', '2']);
    assert.equal(stable.status, 1, `${stable.stdout}\n${stable.stderr}`);
    const stableVerification = stable.envelope.data.verification;
    assert.equal(stableVerification.outcome, 'failed');
    assert.equal(stableVerification.repeat.stable, true);
    assert.equal(stableVerification.repeat.code, undefined);
    assert.equal(stableVerification.repeat.drifting, undefined);
  } finally {
    await stopServers(children);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('setup preflight fails append-only setup, passes a deterministic seed, and records the result', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-preflight-v8-'));
  try {
    await writeFile(path.join(dir, 'placeholder.txt'), '');
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Setup preflight');
    await saveChange(file, {
      ...change,
      checks: [{ id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' }],
    });
    await mkdir(path.join(dir, 'data'), { recursive: true });
    await writeFile(path.join(dir, 'data', 'count.txt'), '0');

    const append = run(dir, ['verify', id, '--check', 'CHECK-CMD', '--record', '--setup', 'node -e "require(\'fs\').appendFileSync(\'data/count.txt\',\'x\')"', '--check-setup-idempotence', '--setup-state', 'data']);
    assert.equal(append.status, 1, `${append.stdout}\n${append.stderr}`);
    const failed = append.envelope.data.verification;
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.setupPreflight.status, 'failed');
    assert.deepEqual(failed.setupPreflight.changed, ['data/count.txt']);
    assert.equal(failed.results[0].status, 'skipped');
    assert.match(failed.environment.setupPreflight.status, /failed/);
    const evidence = append.envelope.data.evidence;
    assert.ok(evidence?.logPath, 'failed preflight evidence should include a verification log');
    assert.equal(evidence.environment.setupPreflight.status, 'failed');
    const log = JSON.parse(await readFile(path.join(dir, '.notchlet', 'changes', id, evidence.logPath), 'utf8'));
    assert.equal(log.setupPreflight.status, 'failed');
    assert.deepEqual(log.setupPreflight.changed, ['data/count.txt']);
    assert.match(log.summary, /setup preflight: failed/);
    assert.match(log.summary, /changed data\/count\.txt/);

    const deterministic = run(dir, ['verify', id, '--check', 'CHECK-CMD', '--setup', 'node -e "require(\'fs\').writeFileSync(\'data/count.txt\',\'3\')"', '--check-setup-idempotence', '--setup-state', 'data']);
    assert.equal(deterministic.status, 0, `${deterministic.stdout}\n${deterministic.stderr}`);
    const passed = deterministic.envelope.data.verification;
    assert.equal(passed.outcome, 'passed');
    assert.equal(passed.setupPreflight.status, 'passed');
    assert.deepEqual(passed.setupPreflight.added, []);
    assert.deepEqual(passed.setupPreflight.removed, []);
    assert.deepEqual(passed.setupPreflight.changed, []);
    assert.equal(await readFile(path.join(dir, 'data', 'count.txt'), 'utf8'), '3');

    const missingFlag = run(dir, ['verify', id, '--check', 'CHECK-CMD', '--setup-state', 'data']);
    assert.equal(missingFlag.envelope.error.code, 'usage_error');
    const missingState = run(dir, ['verify', id, '--check', 'CHECK-CMD', '--check-setup-idempotence']);
    assert.equal(missingState.envelope.error.code, 'usage_error');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('archived status reports the same coverage evidence IDs as the closure manifest', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-coverage-v8-'));
  try {
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Archived coverage');
    const requirement = { id: 'REQ-1', title: 'Requirement', description: 'Existing behavior remains.' };
    const scenario = { id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'Acceptance runs', then: 'Behavior remains available.' };
    await saveChange(file, {
      ...change,
      capabilityImpact: 'none', capabilityRationale: 'Documentation-only maintenance with no durable behavior change.',
      intent: 'Maintain behavior', outcome: 'Behavior is unchanged',
      requirements: [requirement], acceptanceScenarios: [scenario],
      checks: [{ id: 'CHECK-1', description: 'Run acceptance check.', requirementIds: ['REQ-1'], scenarioIds: ['SCENARIO-1'] }],
      tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-1'] }],
    });
    assert.equal(run(dir, ['change', 'render', id, '--write']).status, 0);
    const evidence = await appendEvidence(dir, id, { kind: 'check', outcome: 'passed', summary: 'Acceptance passed', requirementIds: ['REQ-1'], scenarioIds: ['SCENARIO-1'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const closed = run(dir, ['change', 'close', id]);
    assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}`);

    const status = run(dir, ['status', id, '--history']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.envelope.data.archived, true);
    assert.equal(status.envelope.data.history.logs >= 0, true);
    const coverage = status.envelope.data.facets.coverage;
    const closure = JSON.parse(await readFile(path.join(dir, '.notchlet', 'archive', id, 'closure.json'), 'utf8'));
    assert.deepEqual(coverage.requirements.items[0].evidenceIds, closure.coverage.requirements.items[0].evidenceIds);
    assert.deepEqual(coverage.scenarios.items[0].evidenceIds, closure.coverage.scenarios.items[0].evidenceIds);
    assert.deepEqual(coverage.requirements.items[0].evidenceIds, [evidence.id]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('readiness aborts when the serve child exits early, passes a slow start, and keeps the full timeout when unreachable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-readiness-v8-'));
  try {
    await initWorkspace(dir);
    const earlyPort = await freePort();
    const early = await newChange(dir, 'Early exit');
    await saveChange(early.file, {
      ...early.change,
      checks: [{ id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' }],
      runCommand: 'node -e "process.exit(7)"',
      readinessUrl: `http://127.0.0.1:${earlyPort}/health`,
      readyTimeoutMs: 20000,
    });
    const earlyRun = run(dir, ['verify', early.id, '--check', 'CHECK-CMD', '--serve', '--ready-timeout', '20000']);
    assert.equal(earlyRun.status, 1, `${earlyRun.stdout}\n${earlyRun.stderr}`);
    const earlyVerification = earlyRun.envelope.data.verification;
    assert.equal(earlyVerification.serve.ready, false);
    assert.equal(earlyVerification.serve.exitCode, 7);
    assert.equal(earlyVerification.readiness.reached, false);
    assert.equal(earlyVerification.readiness.exitCode, 7);
    assert.ok(earlyVerification.readiness.waitedMs < 5000, `expected fast failure, waited ${earlyVerification.readiness.waitedMs}ms`);
    assert.match(earlyVerification.readiness.error, /exit code 7/);

    const slowPort = await freePort();
    await writeFile(path.join(dir, 'slow-server.mjs'), `import { createServer } from 'node:http';
setTimeout(() => {
  const server = createServer((request, response) => response.end('ok'));
  server.listen(${slowPort}, '127.0.0.1', () => console.log('ready'));
}, 700);
`);
    const slow = await newChange(dir, 'Slow start');
    await saveChange(slow.file, {
      ...slow.change,
      checks: [{ id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' }],
      runCommand: 'node slow-server.mjs',
      readinessUrl: `http://127.0.0.1:${slowPort}/health`,
      readyTimeoutMs: 8000,
    });
    const slowRun = run(dir, ['verify', slow.id, '--check', 'CHECK-CMD', '--serve', '--ready-timeout', '8000']);
    assert.equal(slowRun.status, 0, `${slowRun.stdout}\n${slowRun.stderr}`);
    const slowVerification = slowRun.envelope.data.verification;
    assert.equal(slowVerification.serve.ready, true);
    assert.equal(slowVerification.readiness.reached, true);
    assert.ok(slowVerification.readiness.waitedMs >= 500);
    assert.ok(slowVerification.readiness.waitedMs < 8000);

    const unreachablePort = await freePort();
    const unreachable = await newChange(dir, 'Unreachable target');
    await saveChange(unreachable.file, {
      ...unreachable.change,
      checks: [{ id: 'CHECK-HTTP', description: 'Health responds', kind: 'http', url: `http://127.0.0.1:${unreachablePort}/health`, expectedStatus: 200 }],
      readinessUrl: `http://127.0.0.1:${unreachablePort}/health`,
      readyTimeoutMs: 1500,
    });
    const unreachableRun = run(dir, ['verify', unreachable.id, '--check', 'CHECK-HTTP', '--ready-timeout', '1500']);
    assert.equal(unreachableRun.status, 1);
    const unreachableVerification = unreachableRun.envelope.data.verification;
    assert.equal(unreachableVerification.readiness.reached, false);
    assert.ok(unreachableVerification.readiness.attempts > 1);
    assert.ok(unreachableVerification.readiness.waitedMs >= 1400, `expected full timeout, waited ${unreachableVerification.readiness.waitedMs}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
