import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

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

function planValue(checks: unknown[]) {
  return { schemaVersion: 1, name: 'V7 plan', intent: 'Exercise V7 plan import', outcome: 'Plan imports losslessly', requirements: [], acceptanceScenarios: [], designDecisions: [], checks, tasks: [], artifactContents: {} };
}

test('plan import preserves scoped assertion selectors, rejects foreign step fields, and plan commands track provenance', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-plan-v7-'));
  try {
    await initWorkspace(dir);
    await mkdir(path.join(dir, '.notchlet', 'plans'), { recursive: true });
    const planFile = path.join(dir, '.notchlet', 'plans', 'v7.json');
    const planText = JSON.stringify(planValue([{ id: 'CHECK-UI', description: 'Scoped assertion', kind: 'ui', url: 'http://127.0.0.1:1/', steps: [{ action: 'assertText', selector: '#result', text: 'Saved Widget' }] }]), null, 2);
    await writeFile(planFile, planText);

    const validated = run(dir, ['change', 'plan', 'validate', '.notchlet/plans/v7.json']);
    assert.equal(validated.status, 0, validated.stderr);
    assert.deepEqual(validated.envelope.data.counts, { requirements: 0, scenarios: 0, checks: 1, tasks: 0 });

    const created = run(dir, ['change', 'new', 'Imported v7', '--from', '.notchlet/plans/v7.json', '--quick']);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    const id = created.envelope.data.id as string;
    const imported = JSON.parse(await readFile(path.join(dir, '.notchlet', 'changes', id, 'tasks.json'), 'utf8'));
    assert.deepEqual(imported.checks[0].steps[0], { action: 'assertText', text: 'Saved Widget', selector: '#result' });

    const current = run(dir, ['change', 'plan', 'status', id]);
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.envelope.data.plan.drift.status, 'none');
    assert.equal(current.envelope.data.plan.validation.status, 'ok');

    await writeFile(planFile, `${planText}\n`);
    const drifted = run(dir, ['change', 'plan', 'status', id]);
    assert.equal(drifted.envelope.data.plan.drift.status, 'drifted');
    const synced = run(dir, ['change', 'plan', 'sync', id]);
    assert.equal(synced.status, 0, `${synced.stdout}\n${synced.stderr}`);
    assert.equal(synced.envelope.data.plan.drift.status, 'none');
    const linked = JSON.parse(await readFile(path.join(dir, '.notchlet', 'changes', id, 'tasks.json'), 'utf8'));
    assert.equal(linked.sourcePlan.sha256, createHash('sha256').update(`${planText}\n`).digest('hex'));

    await writeFile(planFile, '{"intent": 5}');
    const invalid = run(dir, ['change', 'plan', 'status', id]);
    assert.equal(invalid.envelope.data.plan.validation.status, 'invalid');
    const refused = run(dir, ['change', 'plan', 'sync', id]);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.envelope.error.code, 'invalid_plan');

    const badPlan = path.join(dir, '.notchlet', 'plans', 'bad.json');
    await writeFile(badPlan, JSON.stringify(planValue([{ id: 'CHECK-BAD', description: 'Bad field', kind: 'ui', url: 'http://127.0.0.1:1/', steps: [{ action: 'assertText', text: 'Saved', contains: 'Saved' }] }])));
    const badImport = run(dir, ['change', 'new', 'Bad plan', '--from', '.notchlet/plans/bad.json', '--quick']);
    assert.notEqual(badImport.status, 0);
    assert.equal(badImport.envelope.error.code, 'invalid_step_field');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('verify persists setup with --save-setup, repeats detect state changes, and history groups repeated failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-setup-v7-'));
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'flaky-server.mjs'), `import { createServer } from 'node:http';
let hits = 0;
const server = createServer((request, response) => {
  hits += 1;
  response.statusCode = hits === 1 ? 200 : 500;
  response.end(hits === 1 ? 'ok' : 'stateful failure');
});
server.listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    await startServer(dir, 'flaky-server.mjs', children);
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Repeat behavior');
    await saveChange(file, {
      ...change,
      checks: [
        { id: 'CHECK-CMD', description: 'Command passes', kind: 'command', command: 'node -e "process.exit(0)"' },
        { id: 'CHECK-FLAKY', description: 'Only passes once', kind: 'http', url: `http://127.0.0.1:${port}/state`, expectedStatus: 200 },
      ],
    });

    const saved = run(dir, ['verify', id, '--check', 'CHECK-CMD', '--setup', 'node -e "console.log(\'seed\')"', '--save-setup']);
    assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(persisted.setupCommand, 'node -e "console.log(\'seed\')"');
    const status = run(dir, ['status', id]);
    assert.equal(status.envelope.data.planDrift.status, 'unlinked');

    const missingSetup = run(dir, ['verify', id, '--save-setup']);
    assert.notEqual(missingSetup.status, 0);
    assert.equal(missingSetup.envelope.error.code, 'usage_error');

    const repeated = run(dir, ['verify', id, '--check', 'CHECK-FLAKY', '--repeat', '2', '--record']);
    assert.equal(repeated.status, 1, `${repeated.stdout}\n${repeated.stderr}`);
    const verification = repeated.envelope.data.verification;
    assert.equal(verification.outcome, 'failed');
    assert.equal(verification.repeat.code, 'state_not_idempotent');
    assert.deepEqual(verification.repeat.differing, ['CHECK-FLAKY']);
    assert.deepEqual(verification.repeat.outcomes.map((outcome: any) => outcome.checks[0].status), ['passed', 'failed']);

    const failedAgain = run(dir, ['verify', id, '--check', 'CHECK-FLAKY', '--record']);
    assert.equal(failedAgain.status, 1);
    const withHistory = run(dir, ['status', id, '--history']);
    assert.equal(withHistory.status, 0, withHistory.stderr);
    const history = withHistory.envelope.data.history;
    assert.ok(history.logs >= 2, `expected at least two recorded attempts, saw ${history.logs}`);
    assert.ok(Array.isArray(history.checks));
    const preview = run(dir, ['change', 'close', id, '--preview']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.envelope.data.planDrift.status, 'unlinked');
  } finally {
    await stopServers(children);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('UI waits distinguish missing, hidden, delayed, and scoped text and warn on presence-only checks', { skip: uiSkip }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-waits-v7-'));
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'waits-server.mjs'), `import { createServer } from 'node:http';
const page = (head, body, script = '') => '<!doctype html><html><head><title>' + head + '</title></head><body>' + body + (script ? '<script>' + script + '</script>' : '') + '</body></html>';
const delayed = page('Delayed', '<div id="app">working</div>', 'setTimeout(() => { const node = document.createElement("div"); node.id = "result"; node.textContent = "Saved Widget"; document.getElementById("app").appendChild(node); }, 800);');
const hidden = page('Hidden', '<div id="app"><div id="result" style="display:none">Saved Widget</div></div>');
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(new URL(request.url, 'http://127.0.0.1').pathname === '/hidden' ? hidden : delayed);
});
server.listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    await startServer(dir, 'waits-server.mjs', children);
    await initWorkspace(dir);
    const { id, file, change } = await newChange(dir, 'Delayed text');
    const base = { description: 'Delayed text', kind: 'ui', url: `http://127.0.0.1:${port}/delayed`, waitFor: '#app', settleMs: 0 };
    await saveChange(file, { ...change, checks: [{ ...base, id: 'CHECK-NOW', steps: [{ action: 'assertText', text: 'Saved Widget' }] }] });
    const immediate = run(dir, ['verify', id]);
    assert.equal(immediate.status, 1, `${immediate.stdout}\n${immediate.stderr}`);
    const immediateFailure = immediate.envelope.data.verification.results[0].assertions.find((assertion: any) => assertion.kind === 'step' && !assertion.passed);
    assert.match(immediateFailure.observed, /text absent/);

    await saveChange(file, { ...change, checks: [
      { ...base, id: 'CHECK-WAIT-TEXT', steps: [{ action: 'waitForText', text: 'Saved Widget', timeoutMs: 3000 }] },
      { ...base, id: 'CHECK-SCOPED', steps: [{ action: 'assertText', selector: '#result', text: 'Saved Widget', timeoutMs: 3000 }] },
    ] });
    const waited = run(dir, ['verify', id]);
    assert.equal(waited.status, 0, `${waited.stdout}\n${waited.stderr}`);
    assert.deepEqual(waited.envelope.data.verification.results.map((check: any) => check.status), ['passed', 'passed']);

    await saveChange(file, { ...change, checks: [
      { ...base, id: 'CHECK-HIDDEN', url: `http://127.0.0.1:${port}/hidden`, steps: [{ action: 'waitForVisible', selector: '#result', timeoutMs: 1000 }] },
      { ...base, id: 'CHECK-PRESENCE', url: `http://127.0.0.1:${port}/hidden`, expectedSelectors: ['#result'] },
    ] });
    const visibility = run(dir, ['verify', id]);
    assert.equal(visibility.status, 1);
    const hiddenCheck = visibility.envelope.data.verification.results.find((check: any) => check.id === 'CHECK-HIDDEN');
    const hiddenFailure = hiddenCheck.assertions.find((assertion: any) => assertion.kind === 'step' && !assertion.passed);
    assert.match(hiddenFailure.observed, /present but hidden/);
    const presence = visibility.envelope.data.advisories.presenceOnly;
    assert.deepEqual(presence.map((item: any) => item.id).sort(), ['CHECK-PRESENCE']);
  } finally {
    await stopServers(children);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
