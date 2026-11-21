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
  const change = JSON.parse(await readFile(file, 'utf8'));
  return { id, file, change };
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

test('schema command lists and prints shipped schemas without a workspace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-schema-'));
  try {
    const listed = run(dir, ['schema']);
    assert.equal(listed.status, 0, listed.stderr);
    const names = listed.envelope.data.schemas.map((schema: any) => schema.name);
    assert(names.includes('plan.v1'));
    assert(names.includes('closure.v1'));

    const printed = run(dir, ['schema', 'closure.v1']);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.envelope.data.schema.$id, 'https://notchlet.dev/schemas/closure-v1.schema.json');

    const missing = run(dir, ['schema', 'missing.v9']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /schema_not_found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI authors rendered UI check settings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-ui-authoring-v5-'));
  try {
    await initWorkspace(dir);
    const { id } = await newChange(dir, 'UI check authoring');
    const added = run(dir, [
      'change', 'add', id, 'check', '--id', 'CHECK-UI', '--description', 'Hydrated UI renders',
      '--kind', 'ui', '--url', 'http://127.0.0.1:1/app', '--wait-for', '#app', '--settle-ms', '250',
      '--expected-selector', '#app', '--expected-selector', '.card', '--expected-text', 'Ready',
      '--expect-no-console-errors', '--full-page',
    ]);
    assert.equal(added.status, 0, added.stderr);
    const shown = run(dir, ['change', 'show', id]);
    const check = shown.envelope.data.change.checks[0];
    assert.equal(check.kind, 'ui');
    assert.equal(check.waitFor, '#app');
    assert.equal(check.settleMs, 250);
    assert.deepEqual(check.expectedSelectors, ['#app', '.card']);
    assert.equal(check.expectedText, 'Ready');
    assert.equal(check.expectedNoConsoleErrors, true);
    assert.equal(check.fullPage, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verify evaluates containment, path, and header assertions and keeps a stable payload shape', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-http-v4-'));
  const childServers: Array<ReturnType<typeof spawn>> = [];
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'server.mjs'), `import { createServer } from 'node:http';
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.setHeader('x-mode', 'test');
  response.end(JSON.stringify({ status: 'ok', note: 'hello world', items: [{ sku: 'B-2', stock: 4 }, { sku: 'A-1', stock: 9 }], summary: { total: 13 } }));
});
server.listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    const server = spawn(process.execPath, ['server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
    childServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.stdout!.on('data', (chunk: Buffer) => { if (chunk.toString('utf8').includes('ready')) resolve(); });
      server.on('error', reject);
    });
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'HTTP assertions');
    const check = {
      id: 'CHECK-HTTP',
      description: 'Catalog contract',
      kind: 'http',
      url: `http://127.0.0.1:${port}/api/catalog`,
      expectedStatus: 200,
      expectedBodyContains: 'hello world',
      expectedJsonContains: { items: [{ sku: 'A-1' }] },
      expectedJsonAt: [{ path: '$.summary.total', gte: 13, lte: 13 }, { path: '$.status', matches: '^ok$' }],
      expectedHeaders: { 'x-mode': 'test', 'content-type': 'application/json' },
    };
    await saveChange(file, { ...change, checks: [check] });
    const passed = run(dir, ['verify', id]);
    assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
    assert.equal(passed.envelope.data.verification.outcome, 'passed');
    assert.equal('verification' in passed.envelope.data, true);
    assert.equal(passed.envelope.data.verification.results[0].assertions.every((assertion: any) => assertion.passed), true);
    assert.equal(passed.envelope.data.verification.environment.platform.startsWith(process.platform), true);

    await saveChange(file, { ...change, checks: [{ ...check, expectedJsonAt: [{ path: '$.summary.total', gte: 99 }] }] });
    const failed = run(dir, ['verify', id]);
    assert.equal(failed.status, 1);
    assert.equal(failed.envelope.data.verification.outcome, 'failed');
    const failedAssertion = failed.envelope.data.verification.results[0].assertions.find((assertion: any) => !assertion.passed);
    assert.equal(failedAssertion.path, '$.summary.total');
    assert.match(failedAssertion.observed, /13/);
  } finally {
    for (const server of childServers) {
      server.kill();
      if (server.exitCode === null) await once(server, 'exit').catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('verify --serve owns readiness, environment, setup, teardown, and cleanup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-serve-v4-'));
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'server.mjs'), `import { createServer } from 'node:http';
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'ok', mode: process.env.API_MODE, path: request.url }));
});
server.listen(${port}, '127.0.0.1');
`);
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Serve lifecycle');
    await saveChange(file, {
      ...change,
      runCommand: 'node server.mjs',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 15000,
      readyIntervalMs: 100,
      environment: { API_MODE: 'serve-test' },
      setupCommand: 'node -e "process.exit(0)"',
      teardownCommand: 'node -e "process.exit(0)"',
      checks: [{
        id: 'CHECK-SERVE',
        description: 'Served app answers with the declared environment',
        kind: 'http',
        url: `http://127.0.0.1:${port}/health`,
        expectedStatus: 200,
        expectedJson: { status: 'ok', mode: 'serve-test' },
      }],
    });
    const verified = run(dir, ['verify', id, '--serve']);
    assert.equal(verified.status, 0, verified.stderr);
    const verification = verified.envelope.data.verification;
    assert.equal(verification.outcome, 'passed');
    assert.equal(verification.serve.started, true);
    assert.equal(verification.serve.reused, false);
    assert.equal(verification.serve.ready, true);
    assert.equal(verification.serve.stopped, true);
    assert.equal(verification.serve.shutdown.reason, 'checks-complete');
    assert.equal(verification.serve.shutdown.expected, true);
    assert.equal(verification.serve.shutdown.requested, true);
    assert.equal(verification.setup.status, 'passed');
    assert.equal(verification.teardown.status, 'passed');
    assert.equal(verification.environment.environment.API_MODE, 'serve-test');
    assert.equal(verification.results[0].status, 'passed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('evidence record builds a scoped record from flags and reports missing browsers for capture', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-evidence-v4-'));
  try {
    await initWorkspace(dir);
    const created = run(dir, ['change', 'new', 'Evidence flags', '--quick']);
    const id = created.envelope.data.id as string;
    const file = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');
    const change = JSON.parse(await readFile(file, 'utf8'));
    const requirement = { id: 'REQ-1', title: 'Manual check', description: 'A human observes the result.' };
    const scenario = { id: 'SCN-1', requirementId: 'REQ-1', when: 'the page opens', then: 'it renders' };
    const task = { id: 'TASK-1', title: 'Observe UI', status: 'completed', dependencies: [], requirementIds: ['REQ-1'] };
    await saveChange(file, { ...change, requirements: [requirement], acceptanceScenarios: [scenario], tasks: [task] });

    const recorded = run(dir, ['evidence', 'record', '--change', id, '--summary', 'Inspected the rendered page', '--kind', 'note', '--outcome', 'informational', '--requirement', 'REQ-1', '--scenario', 'SCN-1', '--task', 'TASK-1']);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.deepEqual(recorded.envelope.data.scenarioIds, ['SCN-1']);
    assert.deepEqual(recorded.envelope.data.requirementIds, ['REQ-1']);

    const missingBrowser = spawnSync(process.execPath, [cli, 'evidence', 'record', '--change', id, '--summary', 'Capture', '--capture-url', 'http://127.0.0.1:1/', '--browser', path.join(dir, 'no-browser.exe'), '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NOTCHLET_BROWSER: '' } });
    assert.notEqual(missingBrowser.status, 0);
    assert.match(missingBrowser.stdout, /browser_not_found|not found/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
