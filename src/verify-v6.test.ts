import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');

function runWithEnv(dir: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', env });
  let envelope: any;
  try { envelope = JSON.parse(result.stdout); } catch { envelope = undefined; }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope };
}

function run(dir: string, args: string[]) {
  return runWithEnv(dir, args, process.env);
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

function browserAvailable(): boolean {
  if (process.env.NOTCHLET_BROWSER?.trim()) return existsSync(process.env.NOTCHLET_BROWSER.trim());
  if (process.env.CHROME_PATH?.trim()) return existsSync(process.env.CHROME_PATH.trim());
  const candidates = [
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter((candidate): candidate is string => typeof candidate === 'string');
  return candidates.some(candidate => existsSync(candidate));
}

const uiSkip = browserAvailable() ? false : 'no Chromium-based browser is installed for headless UI checks';

test('verify --serve refuses a foreign listener before setup and reuses only on explicit request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-foreign-v6-'));
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'external.mjs'), `import { createServer } from 'node:http';
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'external' }));
});
server.listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    await startServer(dir, 'external.mjs', children);
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Foreign listener');
    await saveChange(file, {
      ...change,
      runCommand: 'node never-starts.mjs',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 3000,
      readyIntervalMs: 100,
      setupCommand: 'node -e "require(\'node:fs\').writeFileSync(\'setup-ran.txt\', \'x\')"',
      checks: [{
        id: 'CHECK-FOREIGN',
        description: 'External server answers',
        kind: 'http',
        url: `http://127.0.0.1:${port}/health`,
        expectedStatus: 200,
        expectedJson: { status: 'external' },
      }],
    });

    const refused = run(dir, ['verify', id, '--serve']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /serve_port_in_use/);
    assert.equal(existsSync(path.join(dir, 'setup-ran.txt')), false, 'setup must not run against a listener verify does not own');

    const reused = run(dir, ['verify', id, '--serve', '--reuse-serve']);
    assert.equal(reused.status, 0, `${reused.stdout}\n${reused.stderr}`);
    const verification = reused.envelope.data.verification;
    assert.equal(verification.outcome, 'passed');
    assert.equal(verification.serve.ownership, 'reused');
    assert.equal(verification.serve.startedBy, 'external');
    assert.equal(verification.serve.reused, true);
    assert.equal(verification.serve.started, false);
    assert.match(verification.setupSkippedReason, /does not own/i);
    assert.equal('setup' in verification, false);
    assert.equal(verification.results[0].status, 'passed');
    assert.equal(existsSync(path.join(dir, 'setup-ran.txt')), false);
    assert.equal(children[0].exitCode, null, 'the reused server must keep running after verify');
  } finally {
    await stopServers(children);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('readiness treats a 500 response as not ready even when other routes respond', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-ready-v6-'));
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'server.mjs'), `import { createServer } from 'node:http';
const server = createServer((request, response) => {
  if (request.url === '/health') { response.statusCode = 500; response.end('warming up'); return; }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'ok' }));
});
server.listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Readiness status');
    await saveChange(file, {
      ...change,
      runCommand: 'node server.mjs',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 1200,
      readyIntervalMs: 100,
      checks: [{
        id: 'CHECK-OTHER-ROUTE',
        description: 'Application route still answers',
        kind: 'http',
        url: `http://127.0.0.1:${port}/app`,
        expectedJson: { status: 'ok' },
      }],
    });

    const verified = run(dir, ['verify', id, '--serve']);
    assert.equal(verified.status, 1);
    const verification = verified.envelope.data.verification;
    assert.equal(verification.outcome, 'failed');
    assert.equal(verification.serve.ready, false);
    assert.equal(verification.readiness.reached, false);
    assert.equal(verification.readiness.status, 500);
    assert.match(verification.readiness.error, /HTTP 500/);
    assert.equal(verification.results[0].status, 'passed');
  } finally {
    await stopServers(children);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('command checks cannot see the ambient PORT but keep declared environment variables', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-isolation-v6-'));
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'server.mjs'), `import { createServer } from 'node:http';
const port = Number(process.env.SERVE_PORT);
if (!port) process.exit(2);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'up' }));
});
server.listen(port, '127.0.0.1', () => console.log('ready'));
`);
    await initWorkspace(dir);
    const env = { ...process.env, PORT: '5999' };
    const { id, file, change } = await newChange(dir, 'Ambient port isolation');
    await saveChange(file, {
      ...change,
      runCommand: 'node server.mjs',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 10000,
      readyIntervalMs: 100,
      environment: { SERVE_PORT: String(port) },
      checks: [{
        id: 'CHECK-ENV',
        description: 'Command check sees only declared environment',
        kind: 'command',
        command: `node -e "process.exit(process.env.PORT ? 4 : process.env.SERVE_PORT === '${port}' ? 0 : 5)"`,
      }],
    });

    const isolated = runWithEnv(dir, ['verify', id, '--serve'], env);
    assert.equal(isolated.status, 0, `${isolated.stdout}\n${isolated.stderr}`);
    const verification = isolated.envelope.data.verification;
    assert.equal(verification.outcome, 'passed');
    assert.deepEqual(verification.commandIsolation, ['PORT']);
    assert.deepEqual(verification.environment.commandIsolation, ['PORT']);
    assert.equal(verification.results[0].status, 'passed');

    const { id: declaredId, file: declaredFile, change: declaredChange } = await newChange(dir, 'Declared port');
    await saveChange(declaredFile, {
      ...declaredChange,
      runCommand: 'node server.mjs',
      readinessUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs: 10000,
      readyIntervalMs: 100,
      environment: { SERVE_PORT: String(port), PORT: '4444' },
      checks: [{
        id: 'CHECK-DECLARED-ENV',
        description: 'Declared PORT reaches the command check',
        kind: 'command',
        command: 'node -e "process.exit(process.env.PORT === \'4444\' ? 0 : 4)"',
      }],
    });
    const declared = runWithEnv(dir, ['verify', declaredId, '--serve'], env);
    assert.equal(declared.status, 0, `${declared.stdout}\n${declared.stderr}`);
    assert.equal(declared.envelope.data.verification.outcome, 'passed');
    assert.equal('commandIsolation' in declared.envelope.data.verification, false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('UI checks prove the create flow, reject a missing handler, and fail hidden elements', { skip: uiSkip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-ui-v6-'));
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'ui-server.mjs'), `import { createServer } from 'node:http';
const document = (title, body, script = '') => '<!doctype html><html><head><title>' + title + '</title></head><body>' + body + (script ? '<script>' + script + '</script>' : '') + '</body></html>';
const form = '<div id="app"><h1 id="heading">Create item</h1><form><input id="name" /><button id="save" type="button">Save</button></form><p id="result"></p></div>';
const working = document('Form Fixture', form, 'document.getElementById("save").addEventListener("click", () => { document.getElementById("result").textContent = "Saved " + document.getElementById("name").value; });');
const broken = document('Form Fixture', form);
const hidden = document('Hidden Fixture', '<div id="app"><h1 id="heading">Hidden form</h1><form id="form" style="display:none"><input id="name" /></form></div>');
const throwing = document('Throwing Fixture', '<div id="app"><h1 id="heading">Throws</h1></div>', 'throw new Error("boom from fixture");');
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (pathname === '/hidden') { response.end(hidden); return; }
  if (pathname === '/throws') { response.end(throwing); return; }
  response.end(pathname === '/broken' ? broken : working);
});
server.listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    await startServer(dir, 'ui-server.mjs', children);
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'UI behavior');
    const flow = {
      id: 'CHECK-FLOW',
      description: 'Saving the form shows the saved value',
      kind: 'ui',
      url: `http://127.0.0.1:${port}/form`,
      waitFor: '#app',
      settleMs: 50,
      expectedTitle: 'Form Fixture',
      expectedVisibleSelectors: ['#name', '#save'],
      expectedEnabledSelectors: ['#save'],
      expectedScopedText: [{ selector: '#heading', contains: 'Create item' }],
      steps: [
        { action: 'fill', selector: '#name', value: 'Widget' },
        { action: 'click', selector: '#save' },
        { action: 'assertText', text: 'Saved Widget' },
      ],
      captureArtifacts: 'always',
    };
    await saveChange(file, { ...change, checks: [flow] });
    const passed = run(dir, ['verify', id]);
    assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
    const passing = passed.envelope.data.verification.results[0];
    assert.equal(passing.status, 'passed');
    assert.deepEqual(passing.rendered.steps.map((step: any) => step.ok), [true, true, true]);
    assert.equal(passing.capture.policy, 'always');
    await access(path.join(dir, passing.capture.screenshotPath));
    await access(path.join(dir, passing.capture.domPath));

    await saveChange(file, { ...change, checks: [{ ...flow, url: `http://127.0.0.1:${port}/broken`, captureArtifacts: undefined }] });
    const broken = run(dir, ['verify', id]);
    assert.equal(broken.status, 1);
    const brokenCheck = broken.envelope.data.verification.results[0];
    assert.equal(brokenCheck.status, 'failed');
    const failedStep = brokenCheck.assertions.find((assertion: any) => assertion.kind === 'step' && !assertion.passed);
    assert.match(failedStep.observed, /text absent/);
    assert.equal(brokenCheck.capture.policy, 'on-failure');
    const brokenDom = await readFile(path.join(dir, brokenCheck.capture.domPath), 'utf8');
    assert.match(brokenDom, /id="save"/);

    await saveChange(file, { ...change, checks: [{ id: 'CHECK-HIDDEN', description: 'Hidden input is not visible', kind: 'ui', url: `http://127.0.0.1:${port}/hidden`, waitFor: '#app', settleMs: 50, expectedVisibleSelectors: ['#name'] }] });
    const hidden = run(dir, ['verify', id]);
    assert.equal(hidden.status, 1);
    const hiddenCheck = hidden.envelope.data.verification.results[0];
    assert.equal(hiddenCheck.status, 'failed');
    const visibleAssertion = hiddenCheck.assertions.find((assertion: any) => assertion.kind === 'visible');
    assert.equal(visibleAssertion.passed, false);
    assert.equal(hiddenCheck.capture.policy, 'on-failure');
    await access(path.join(dir, hiddenCheck.capture.screenshotPath));

    await saveChange(file, { ...change, checks: [{ id: 'CHECK-CONSOLE', description: 'Page throws', kind: 'ui', url: `http://127.0.0.1:${port}/throws`, waitFor: '#app', settleMs: 50, expectedNoConsoleErrors: true }] });
    const consoleFailure = run(dir, ['verify', id]);
    assert.equal(consoleFailure.status, 1);
    const consoleAssertion = consoleFailure.envelope.data.verification.results[0].assertions.find((assertion: any) => assertion.kind === 'console');
    assert.equal(consoleAssertion.passed, false);
    assert.match(consoleAssertion.observed, /boom from fixture/);
    assert.match(consoleAssertion.observed, /\/throws:\d+/);
  } finally {
    await stopServers(children);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('status reports plan drift from the imported plan hash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-drift-cli-v6-'));
  try {
    await initWorkspace(dir);
    await mkdir(path.join(dir, '.notchlet', 'plans'), { recursive: true });
    const planFile = path.join(dir, '.notchlet', 'plans', 'feature.json');
    const planText = JSON.stringify({ name: 'Drift import', intent: 'Import the plan', outcome: 'Plan is linked' }, null, 2);
    await writeFile(planFile, planText);
    const created = run(dir, ['change', 'new', 'Drift import', '--from', '.notchlet/plans/feature.json', '--quick']);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    const id = created.envelope.data.id as string;

    const current = run(dir, ['status', id]);
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.envelope.data.planDrift.status, 'none');
    assert.equal(current.envelope.data.planDrift.path, '.notchlet/plans/feature.json');
    const currentPreview = run(dir, ['change', 'close', id, '--preview']);
    assert.equal(currentPreview.status, 0, currentPreview.stderr);
    assert.equal(currentPreview.envelope.data.planDrift.status, 'none');

    await writeFile(planFile, `${planText}\n`);
    assert.equal(run(dir, ['status', id]).envelope.data.planDrift.status, 'drifted');
    const driftedPreview = run(dir, ['change', 'close', id, '--preview']);
    assert.equal(driftedPreview.status, 0, driftedPreview.stderr);
    assert.equal(driftedPreview.envelope.data.planDrift.status, 'drifted');

    await rm(planFile);
    assert.equal(run(dir, ['status', id]).envelope.data.planDrift.status, 'missing');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
