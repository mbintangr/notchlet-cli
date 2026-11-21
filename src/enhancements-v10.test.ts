import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
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

async function newChange(dir: string, name: string): Promise<string> {
  const created = run(dir, ['change', 'new', name, '--quick']);
  assert.equal(created.status, 0, created.stderr);
  return created.envelope.data.id as string;
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

test('status exposes execution metadata and reports each blocker once', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-status-v10-'));
  try {
    await initWorkspace(dir);
    const id = await newChange(dir, 'Status metadata');

    const fresh = run(dir, ['status', id]);
    assert.equal(fresh.status, 0, fresh.stderr);
    const freshData = fresh.envelope.data;
    assert.equal(typeof freshData.execution, 'object');
    assert.equal('setupCommand' in freshData.execution, false, 'unset metadata is omitted rather than null');
    const messages = freshData.facets.blockers.map((blocker: any) => blocker.message);
    assert.equal(freshData.facets.blockers.length, 10);
    assert.equal(new Set(messages).size, messages.length);
    assert.equal(freshData.facets.closure.blockerCount, 10);
    for (const code of ['baseline_revision_missing', 'capability_impact_required', 'tasks_incomplete', 'acceptance_missing']) {
      assert.ok(freshData.facets.blockers.some((blocker: any) => blocker.code === code), `${code} remains visible`);
    }
    const freshShow = run(dir, ['change', 'show', id]);
    assert.equal('setupCommand' in freshShow.envelope.data.change, false);

    const updated = run(dir, ['change', 'update', id,
      '--run-command', 'node server.mjs',
      '--setup', 'node seed.mjs',
      '--teardown', 'node teardown.mjs',
      '--preview-url', 'http://127.0.0.1:3000/',
      '--readiness-url', 'http://127.0.0.1:3000/health',
      '--ready-timeout', '20000',
      '--ready-interval', '100',
      '--environment', 'PORT=3000',
    ]);
    assert.equal(updated.status, 0, updated.stderr);
    const status = run(dir, ['status', id]);
    const shown = run(dir, ['change', 'show', id]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(status.envelope.data.facets.blockers.length, 10, 'metadata updates do not add planning blockers');
    const execution = status.envelope.data.execution;
    const change = shown.envelope.data.change;
    assert.deepEqual(execution, {
      runCommand: 'node server.mjs',
      setupCommand: 'node seed.mjs',
      teardownCommand: 'node teardown.mjs',
      previewUrl: 'http://127.0.0.1:3000/',
      readinessUrl: 'http://127.0.0.1:3000/health',
      readyTimeoutMs: 20000,
      readyIntervalMs: 100,
      environment: { PORT: '3000' },
    });
    for (const key of Object.keys(execution)) assert.deepEqual((execution as any)[key], (change as any)[key]);

    const saved = await newChange(dir, 'Saved setup');
    const added = run(dir, ['change', 'add', saved, 'check', '--id', 'CHECK-1', '--description', 'Command passes', '--command', 'node -e "process.exit(0)"']);
    assert.equal(added.status, 0, added.stderr);
    const verified = run(dir, ['verify', saved, '--check', 'CHECK-1', '--setup', 'node -e "process.exit(0)"', '--save-setup']);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    const savedStatus = run(dir, ['status', saved]);
    const savedShow = run(dir, ['change', 'show', saved]);
    assert.equal(savedStatus.envelope.data.execution.setupCommand, savedShow.envelope.data.change.setupCommand);

    const cleanRender = run(dir, ['change', 'render', id, '--check']);
    assert.equal(cleanRender.status, 0, cleanRender.stdout);
    assert.ok(cleanRender.envelope.data.artifacts.length > 0);
    assert.ok(cleanRender.envelope.data.artifacts.every((artifact: any) => artifact.drift === 'none'));
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('stable reached repeats omit the repeat readiness line from human and evidence output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-repeat-v10-'));
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'server.mjs'), `import { createServer } from 'node:http';
createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.end('{"status":"ok"}');
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await initWorkspace(dir);
    const id = await newChange(dir, 'Stable repeat');
    const updated = run(dir, ['change', 'update', id,
      '--run-command', 'node server.mjs',
      '--readiness-url', `http://127.0.0.1:${port}/health`,
      '--ready-timeout', '5000',
      '--environment', `PORT=${port}`,
    ]);
    assert.equal(updated.status, 0, updated.stderr);
    const added = run(dir, ['change', 'add', id, 'check', '--id', 'CHECK-1', '--description', 'Command passes', '--command', 'node -e "process.exit(0)"']);
    assert.equal(added.status, 0, added.stderr);

    const recorded = run(dir, ['verify', id, '--check', 'CHECK-1', '--serve', '--repeat', '2', '--ready-timeout', '5000', '--record']);
    assert.equal(recorded.status, 0, `${recorded.stdout}\n${recorded.stderr}`);
    assert.equal(recorded.envelope.data.verification.outcome, 'passed');
    assert.equal(recorded.envelope.data.verification.repeat.stable, true);
    assert.equal(recorded.envelope.data.verification.repeat.readiness.stable, true);
    const evidenceFile = path.join(dir, '.notchlet', 'changes', id, 'evidence.jsonl');
    const lines = (await readFile(evidenceFile, 'utf8')).trim().split(/\r?\n/);
    const evidence = JSON.parse(lines.at(-1)!);
    assert.doesNotMatch(evidence.summary, /repeat readiness/i);

    const human = runHuman(dir, ['verify', id, '--check', 'CHECK-1', '--serve', '--repeat', '2', '--ready-timeout', '5000']);
    assert.equal(human.status, 0, `${human.stdout}\n${human.stderr}`);
    assert.match(human.stdout, /Repeat: 2 attempt\(s\): stable/);
    assert.doesNotMatch(human.stdout, /Repeat readiness/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('failurePhase identifies readiness, setup, checks, and passing outcomes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-phase-v10-'));
  let failing: ReturnType<typeof spawn> | undefined;
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'fail-server.mjs'), `import { createServer } from 'node:http';
createServer((_request, response) => {
  response.statusCode = 500;
  response.end('not ok');
}).listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    failing = spawn(process.execPath, ['fail-server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      failing!.stdout!.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
      failing!.on('exit', code => reject(new Error(`fail server exited with ${code}`)));
    });
    await initWorkspace(dir);

    const gated = await newChange(dir, 'Readiness gated');
    const gatedPort = await freePort();
    const gatedUpdate = run(dir, ['change', 'update', gated,
      '--run-command', 'node -e "process.exit(9)"',
      '--readiness-url', `http://127.0.0.1:${gatedPort}/health`,
      '--ready-timeout', '5000',
    ]);
    assert.equal(gatedUpdate.status, 0, gatedUpdate.stderr);
    assert.equal(run(dir, ['change', 'add', gated, 'check', '--id', 'CHECK-CMD', '--description', 'Command passes', '--command', 'node -e "process.exit(0)"']).status, 0);
    assert.equal(run(dir, ['change', 'add', gated, 'check', '--id', 'CHECK-HTTP', '--description', 'Health responds', '--kind', 'http', '--url', `http://127.0.0.1:${gatedPort}/health`, '--expected-status', '200']).status, 0);
    const gatedRun = run(dir, ['verify', gated, '--check', 'CHECK-CMD,CHECK-HTTP', '--serve', '--ready-timeout', '5000']);
    assert.equal(gatedRun.status, 1, `${gatedRun.stdout}\n${gatedRun.stderr}`);
    const gatedVerification = gatedRun.envelope.data.verification;
    assert.equal(gatedVerification.failurePhase, 'readiness');
    assert.equal(gatedVerification.blocked, 1);
    assert.equal(gatedVerification.results.find((check: any) => check.id === 'CHECK-HTTP').blockedBy, 'readiness');

    const httpChange = await newChange(dir, 'HTTP failure');
    assert.equal(run(dir, ['change', 'add', httpChange, 'check', '--id', 'CHECK-HTTP', '--description', 'Health responds', '--kind', 'http', '--url', `http://127.0.0.1:${port}/health`, '--expected-status', '200']).status, 0);
    const httpRun = run(dir, ['verify', httpChange, '--check', 'CHECK-HTTP']);
    assert.equal(httpRun.status, 1, `${httpRun.stdout}\n${httpRun.stderr}`);
    const httpVerification = httpRun.envelope.data.verification;
    assert.equal(httpVerification.failurePhase, 'checks');
    assert.equal(httpVerification.blocked, undefined);

    const passing = await newChange(dir, 'Passing');
    assert.equal(run(dir, ['change', 'add', passing, 'check', '--id', 'CHECK-1', '--description', 'Command passes', '--command', 'node -e "process.exit(0)"']).status, 0);
    const passingRun = run(dir, ['verify', passing, '--check', 'CHECK-1']);
    assert.equal(passingRun.status, 0, `${passingRun.stdout}\n${passingRun.stderr}`);
    assert.equal(passingRun.envelope.data.verification.failurePhase, undefined);

    await writeFile(path.join(dir, 'setup.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync('state.txt', 'x');
`);
    const preflight = await newChange(dir, 'Preflight failure');
    assert.equal(run(dir, ['change', 'add', preflight, 'check', '--id', 'CHECK-1', '--description', 'Command passes', '--command', 'node -e "process.exit(0)"']).status, 0);
    const preflightRun = run(dir, ['verify', preflight, '--check', 'CHECK-1', '--setup', 'node setup.mjs', '--check-setup-idempotence', '--setup-state', 'state.txt']);
    assert.equal(preflightRun.status, 1, `${preflightRun.stdout}\n${preflightRun.stderr}`);
    const preflightVerification = preflightRun.envelope.data.verification;
    assert.equal(preflightVerification.failurePhase, 'setup');
    assert.equal(preflightVerification.blocked, 1);
    assert.equal(preflightVerification.results[0].blockedBy, 'setup');
  } finally {
    failing?.kill();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('change help documents run metadata through change update', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-help-v10-'));
  try {
    await initWorkspace(dir);
    const help = runHuman(dir, ['change', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Update change fields, including run and verification metadata/);
    assert.match(help.stdout, /Set local run metadata without editing `tasks\.json`/);
    assert.match(help.stdout, /change update <change> --run-command/);
    assert.match(help.stdout, /--readiness-url/);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
