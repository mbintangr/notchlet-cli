import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  let envelope: any;
  try { envelope = JSON.parse(result.stdout); } catch { envelope = undefined; }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope };
}

function runHuman(dir: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000 });
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

async function logFiles(dir: string, id: string): Promise<string[]> {
  const directory = path.join(dir, '.notchlet', 'changes', id, 'evidence', 'logs');
  return (await readdir(directory).catch(() => [])).filter(entry => entry.endsWith('.json')).sort();
}

test('repeat reports readiness drift, keeps identical exits stable, and detects reached-to-failed changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-ready-repeat-v9-'));
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'ready-drift.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
let count = 0;
try { count = Number(readFileSync('ready-count.txt', 'utf8')); } catch {}
count += 1;
writeFileSync('ready-count.txt', String(count));
process.exit(6 + count);
`);
    await initWorkspace(dir);

    const drift = await newChange(dir, 'Readiness drift');
    await saveChange(drift.file, {
      ...drift.change,
      checks: [{ id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' }],
      runCommand: 'node ready-drift.mjs',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
    });
    const drifted = run(dir, ['verify', drift.id, '--serve', '--repeat', '2', '--ready-timeout', '5000']);
    assert.equal(drifted.status, 1, `${drifted.stdout}\n${drifted.stderr}`);
    assert.equal(drifted.envelope.data.result, 'failed');
    const driftVerification = drifted.envelope.data.verification;
    assert.equal(driftVerification.outcome, 'failed');
    assert.equal(driftVerification.repeat.stable, false);
    assert.equal(driftVerification.repeat.code, 'readiness_drift_under_stable_failure');
    assert.equal(driftVerification.repeat.setupRan, false);
    assert.deepEqual(driftVerification.repeat.readiness.observations.map((observation: any) => observation.exitCode), [7, 8]);
    assert.deepEqual(driftVerification.repeat.outcomes.map((outcome: any) => outcome.readiness.exitCode), [7, 8]);
    assert.equal(driftVerification.repeat.outcomes.every((outcome: any) => outcome.readinessReached === false), true);
    assert.equal(driftVerification.repeat.hints.length, 1);
    assert.match(driftVerification.repeat.hints[0], /not reached \(exit 7\) → not reached \(exit 8\)/);

    const driftHuman = runHuman(dir, ['verify', drift.id, '--serve', '--repeat', '2', '--ready-timeout', '5000']);
    assert.equal(driftHuman.status, 1, `${driftHuman.stdout}\n${driftHuman.stderr}`);
    assert.match(driftHuman.stdout, /Repeat readiness: not reached \(exit 9\) → not reached \(exit 10\)/);
    assert.match(driftHuman.stdout, /Repeat hint: repeat readiness/);

    const stable = await newChange(dir, 'Stable exit');
    await saveChange(stable.file, {
      ...stable.change,
      checks: [{ id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' }],
      runCommand: 'node -e "process.exit(7)"',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
    });
    const stableRun = run(dir, ['verify', stable.id, '--serve', '--repeat', '2', '--ready-timeout', '5000']);
    assert.equal(stableRun.status, 1, `${stableRun.stdout}\n${stableRun.stderr}`);
    const stableVerification = stableRun.envelope.data.verification;
    assert.equal(stableVerification.repeat.stable, true);
    assert.equal(stableVerification.repeat.readiness.stable, true);
    assert.deepEqual(stableVerification.repeat.readiness.observations.map((observation: any) => observation.exitCode), [7, 7]);
    assert.equal(stableVerification.repeat.hints, undefined);

    await writeFile(path.join(dir, 'reach-once.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
let count = 0;
try { count = Number(readFileSync('reach-count.txt', 'utf8')); } catch {}
count += 1;
writeFileSync('reach-count.txt', String(count));
if (count === 1) {
  createServer((_request, response) => response.end('ok')).listen(${port}, '127.0.0.1');
} else {
  process.exit(8);
}
`);
    const mixed = await newChange(dir, 'Reach once');
    await saveChange(mixed.file, {
      ...mixed.change,
      checks: [{ id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' }],
      runCommand: 'node reach-once.mjs',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 5000,
    });
    const mixedRun = run(dir, ['verify', mixed.id, '--serve', '--repeat', '2', '--ready-timeout', '5000']);
    assert.equal(mixedRun.status, 1, `${mixedRun.stdout}\n${mixedRun.stderr}`);
    const mixedVerification = mixedRun.envelope.data.verification;
    assert.equal(mixedVerification.repeat.stable, false);
    assert.deepEqual(mixedVerification.repeat.readiness.observations.map((observation: any) => observation.reached), [true, false]);
    assert.deepEqual(mixedVerification.repeat.outcomes.map((outcome: any) => outcome.outcome), ['passed', 'failed']);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('a failed owned readiness gates HTTP checks while command checks still run', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-ready-gate-v9-'));
  try {
    const port = await freePort();
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Readiness gate');
    await saveChange(file, {
      ...change,
      checks: [
        { id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' },
        { id: 'CHECK-HTTP', description: 'Health responds', kind: 'http', url: `http://127.0.0.1:${port}/health`, expectedStatus: 200 },
      ],
      runCommand: 'node -e "process.exit(7)"',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 3000,
    });
    const verified = run(dir, ['verify', id, '--serve', '--ready-timeout', '3000']);
    assert.equal(verified.status, 1, `${verified.stdout}\n${verified.stderr}`);
    assert.equal(verified.envelope.data.result, 'failed');
    const verification = verified.envelope.data.verification;
    assert.equal(verification.outcome, 'failed');
    assert.equal(verification.readiness.reached, false);
    assert.equal(verification.readiness.exitCode, 7);
    assert.equal(verification.passed, 1);
    assert.equal(verification.failed, 0);
    assert.equal(verification.skipped, 1);
    const command = verification.results.find((check: any) => check.id === 'CHECK-CMD');
    const http = verification.results.find((check: any) => check.id === 'CHECK-HTTP');
    assert.equal(command.status, 'passed');
    assert.match(command.hints.join(' '), /does not prove the server contract/);
    assert.equal(http.status, 'skipped');
    assert.equal(http.blockedBy, 'readiness');
    assert.match(http.stderr, /App never became ready: .*exit code 7/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('a failed preflight persists a diagnostic log and recovery without --record while a passing preflight stays quiet', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-preflight-diag-v9-'));
  try {
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Preflight diagnostics');
    await saveChange(file, {
      ...change,
      checks: [{ id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' }],
    });
    await mkdir(path.join(dir, 'data'), { recursive: true });
    await writeFile(path.join(dir, 'data', 'count.txt'), '0');

    const failed = run(dir, ['verify', id, '--check', 'CHECK-CMD', '--setup', 'node -e "require(\'fs\').appendFileSync(\'data/count.txt\',\'x\')"', '--check-setup-idempotence', '--setup-state', 'data']);
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    const verification = failed.envelope.data.verification;
    assert.equal(verification.outcome, 'failed');
    assert.equal(verification.setupPreflight.status, 'failed');
    assert.deepEqual(verification.setupPreflight.changed, ['data/count.txt']);
    assert.equal(verification.setupPreflight.firstExitCode, 0);
    assert.equal(verification.setupPreflight.secondExitCode, 0);
    assert.match(verification.setupPreflight.recovery, /identical after two runs/);
    assert.match(verification.setupPreflight.note, /second run/);
    assert.equal(failed.envelope.data.evidence, undefined);
    assert.ok(failed.envelope.data.diagnosticLog?.logPath, 'a failed preflight must persist a diagnostic log without --record');
    assert.match(failed.envelope.data.recovery, /identical after two runs/);
    const logs = await logFiles(dir, id);
    assert.equal(logs.length, 1);
    const log = JSON.parse(await readFile(path.join(dir, '.notchlet', 'changes', id, failed.envelope.data.diagnosticLog.logPath), 'utf8'));
    assert.equal(log.setupPreflight.status, 'failed');
    assert.deepEqual(log.setupPreflight.changed, ['data/count.txt']);
    assert.equal(log.checks[0].status, 'skipped');

    const history = run(dir, ['status', id, '--history']);
    assert.equal(history.status, 0, history.stderr);
    assert.equal(history.envelope.data.history.setupPreflight.status, 'failed');
    assert.deepEqual(history.envelope.data.history.setupPreflight.changed, ['data/count.txt']);
    const historyHuman = runHuman(dir, ['status', id, '--history']);
    assert.equal(historyHuman.status, 0, historyHuman.stderr);
    assert.match(historyHuman.stdout, /Setup preflight: failed at/);

    const passed = run(dir, ['verify', id, '--check', 'CHECK-CMD', '--setup', 'node -e "require(\'fs\').writeFileSync(\'data/count.txt\',\'3\')"', '--check-setup-idempotence', '--setup-state', 'data']);
    assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
    assert.equal(passed.envelope.data.result, 'passed');
    assert.equal(passed.envelope.data.verification.setupPreflight.status, 'passed');
    assert.equal(passed.envelope.data.evidence, undefined);
    assert.equal(passed.envelope.data.diagnosticLog, undefined);
    assert.equal((await logFiles(dir, id)).length, 1, 'a passing preflight must not add a diagnostic log without --record');

    const failedHuman = runHuman(dir, ['verify', id, '--check', 'CHECK-CMD', '--setup', 'node -e "require(\'fs\').appendFileSync(\'data/count.txt\',\'x\')"', '--check-setup-idempotence', '--setup-state', 'data']);
    assert.equal(failedHuman.status, 1, `${failedHuman.stdout}\n${failedHuman.stderr}`);
    assert.match(failedHuman.stdout, /Preflight recovery: Fix/);
    assert.match(failedHuman.stdout, /Diagnostic log: \.notchlet\/changes\//);
    assert.match(failedHuman.stdout, /setup exits 0 then 0/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('plan import renders by default, reports the policy advisory, and separates generated-state from authored drift', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-render-v9-'));
  try {
    await initWorkspace(dir);
    const planPath = path.join(dir, 'plan.json');
    const plan = {
      name: 'Rendered plan', mode: 'quick',
      intent: 'Exercise automatic rendering',
      outcome: 'Artifacts stay current without a manual render',
      capabilityImpact: 'none', capabilityRationale: 'No capability change.',
      requirements: [{ id: 'REQ-1', title: 'Requirement', description: 'Behavior remains.' }],
      acceptanceScenarios: [{ id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'Checks run', then: 'They pass.' }],
      checks: [{ id: 'CHECK-1', description: 'Command passes', command: 'node -e "process.exit(0)"', requirementIds: ['REQ-1'], scenarioIds: ['SCENARIO-1'], taskIds: ['TASK-1'] }],
      tasks: [{ id: 'TASK-1', title: 'Do work', requirementIds: ['REQ-1'] }],
    };
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    const imported = run(dir, ['change', 'new', '--from', planPath, '--markdown']);
    assert.equal(imported.status, 0, imported.stderr);
    const importedData = imported.envelope.data;
    assert.equal(importedData.advisory.code, 'evidence_policy_default');
    assert.match(importedData.advisory.message, /default per-task policy/);
    assert.equal(importedData.import.written.includes('proposal.json'), true);
    assert.equal(importedData.import.rendered.includes('tasks.md'), true);

    const current = run(dir, ['change', 'render', importedData.id, '--check']);
    assert.equal(current.status, 0, current.stdout);
    assert.equal(current.envelope.data.drifted, false);

    const planStatus = run(dir, ['change', 'plan', 'status', importedData.id]);
    assert.equal(planStatus.status, 0, planStatus.stderr);
    assert.match(planStatus.envelope.data.plan.contractSha256, /^[a-f0-9]{64}$/);
    assert.match(planStatus.envelope.data.plan.currentSha256, /^[a-f0-9]{64}$/);

    const completion = run(dir, ['task', 'complete', '--all', '--change', importedData.id]);
    assert.equal(completion.status, 0, completion.stderr);
    assert.equal(completion.envelope.warnings.length, 1);
    assert.equal(completion.envelope.warnings[0].policy, 'per-task');
    assert.match(completion.envelope.warnings[0].recovery, /--evidence-policy end-of-change/);

    const drifted = run(dir, ['change', 'render', importedData.id, '--check']);
    assert.equal(drifted.status, 1);
    const tasksView = drifted.envelope.data.artifacts.find((artifact: any) => artifact.artifact === 'tasks.md');
    assert.equal(tasksView.status, 'drifted');
    assert.equal(tasksView.drift, 'generated-state');
    assert.equal(drifted.envelope.data.artifacts.find((artifact: any) => artifact.artifact === 'proposal.json').status, 'current');

    const verified = run(dir, ['verify', importedData.id, '--check', 'CHECK-1']);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    assert.equal(verified.envelope.data.result, 'passed');
    assert.equal(verified.envelope.data.drifted, true);
    assert.equal(verified.envelope.data.renderRecovery, `notchlet change render ${importedData.id} --write`);

    const policyPlanPath = path.join(dir, 'policy-plan.json');
    await writeFile(policyPlanPath, `${JSON.stringify({ ...plan, name: 'Policy plan', evidencePolicy: 'end-of-change' }, null, 2)}\n`);
    const policyImport = run(dir, ['change', 'new', '--from', policyPlanPath]);
    assert.equal(policyImport.status, 0, policyImport.stderr);
    assert.equal(policyImport.envelope.data.advisory, undefined);

    const plain = run(dir, ['change', 'new', 'Plain change', '--quick']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.envelope.data.advisory.code, 'evidence_policy_default');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
