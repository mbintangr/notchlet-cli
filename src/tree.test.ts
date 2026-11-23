import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
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

test('change tree creates, reports, and guards a backlog hierarchy offline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-tree-'));
  try {
    assert.equal(run(dir, ['init']).status, 0);
    const epic = run(dir, ['change', 'new', 'User authentication', '--as', 'epic', '--json']);
    assert.equal(epic.status, 0);
    assert.equal(JSON.parse(epic.stdout).data.relativePath, 'user-authentication');
    assert.equal(JSON.parse(epic.stdout).data.backlogType, 'EPIC');
    assert.equal(JSON.parse(epic.stdout).data.advisory.code, 'evidence_policy_default');

    const story = run(dir, ['change', 'new', 'Login', '--as', 'story', '--parent', 'user-authentication', '--json']);
    assert.equal(story.status, 0);
    assert.equal(JSON.parse(story.stdout).data.advisory, undefined);
    const task = run(dir, ['change', 'new', 'Login form', '--as', 'task', '--parent', 'user-authentication/login', '--json']);
    assert.equal(task.status, 0);
    assert.equal(JSON.parse(task.stdout).data.relativePath, 'user-authentication/login/login-form');

    const wrongLevel = run(dir, ['change', 'new', 'Skipped', '--as', 'task', '--parent', 'user-authentication', '--json']);
    assert.equal(wrongLevel.status, 1);
    assert.equal(JSON.parse(wrongLevel.stdout).error.code, 'invalid_node_type');

    const tree = run(dir, ['change', 'tree', '--json']);
    assert.equal(tree.status, 0);
    const data = JSON.parse(tree.stdout).data;
    assert.deepEqual(data.tree.counts, { total: 3, open: 3, inProgress: 0, inReview: 0, done: 0, leaves: 1, archived: 0 });
    assert.equal(data.tree.roots[0].backlog.itemType, 'EPIC');
    assert.equal(data.tree.roots[0].children[0].children[0].relativePath, 'user-authentication/login/login-form');

    const subtree = run(dir, ['change', 'tree', 'login-form', '--json']);
    assert.equal(subtree.status, 0);
    assert.equal(JSON.parse(subtree.stdout).data.tree.roots[0].relativePath, 'user-authentication/login/login-form');

    const text = run(dir, ['change', 'tree']);
    assert.equal(text.status, 0);
    assert.match(text.stdout, /EPIC user-authentication \[open\]/);
    assert.match(text.stdout, /SUBTASK|TASK user-authentication\/login\/login-form \[open\]/);
    assert.match(text.stdout, /Next: user-authentication\/login\/login-form/);

    const guarded = run(dir, ['task', 'start', 'TASK-1', '--change', 'user-authentication']);
    assert.equal(guarded.status, 1);
    assert.match(guarded.stderr, /rollup_node/);

    const status = run(dir, ['status', 'user-authentication', '--tree', '--json']);
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).data.tree.roots[0].children[0].relativePath, 'user-authentication/login');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('change render --tree checks and writes every open node in the subtree', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-tree-render-'));
  try {
    assert.equal(run(dir, ['init']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Outcome tree', '--as', 'epic']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Outcome story', '--as', 'story', '--parent', 'outcome-tree']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Outcome task', '--as', 'task', '--parent', 'outcome-tree/outcome-story']).status, 0);

    const missingMode = run(dir, ['change', 'render', 'outcome-tree', '--tree']);
    assert.equal(missingMode.status, 64);
    assert.match(missingMode.stderr, /--tree requires --check or --write/);

    const baseline = run(dir, ['change', 'render', 'outcome-tree', '--tree', '--write', '--json']);
    assert.equal(baseline.status, 0, baseline.stderr);
    const baselineData = JSON.parse(baseline.stdout).data;
    assert.deepEqual(baselineData.tree.map((entry: any) => entry.relativePath), ['outcome-tree', 'outcome-tree/outcome-story', 'outcome-tree/outcome-story/outcome-task']);
    assert.ok(baselineData.tree.every((entry: any) => entry.error === undefined));

    const current = run(dir, ['change', 'render', 'outcome-tree', '--tree', '--check', '--json']);
    assert.equal(current.status, 0, current.stdout);
    assert.equal(JSON.parse(current.stdout).data.drifted, false);

    for (const ref of ['outcome-tree', 'outcome-tree/outcome-story', 'outcome-tree/outcome-story/outcome-task']) {
      const updated = run(dir, ['change', 'update', ref, '--outcome', `Outcome for ${ref}`]);
      assert.equal(updated.status, 0, updated.stderr);
    }
    const drifted = run(dir, ['change', 'render', 'outcome-tree', '--tree', '--check', '--json']);
    assert.equal(drifted.status, 1);
    const driftedData = JSON.parse(drifted.stdout).data;
    assert.equal(driftedData.drifted, true);
    assert.equal(driftedData.tree.filter((entry: any) => entry.drifted).length, 3);

    const rendered = run(dir, ['change', 'render', 'outcome-tree', '--tree', '--write', '--json']);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(JSON.parse(rendered.stdout).data.tree.every((entry: any) => entry.error === undefined));

    const cleared = run(dir, ['change', 'render', 'outcome-tree', '--tree', '--check', '--json']);
    assert.equal(cleared.status, 0, cleared.stdout);
    assert.equal(JSON.parse(cleared.stdout).data.drifted, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validate treats a node with children as a rollup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-tree-validate-'));
  try {
    assert.equal(run(dir, ['init']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Epic', '--as', 'epic']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Story', '--as', 'story', '--parent', 'epic']).status, 0);
    assert.equal(run(dir, ['change', 'update', 'epic', '--intent', 'Roll up the children.', '--outcome', 'Children deliver the epic outcome.', '--capability-impact', 'none', '--capability-rationale', 'Rollup only.']).status, 0);
    assert.equal(run(dir, ['change', 'add', 'epic', 'requirement', '--id', 'R1', '--title', 'Outcome', '--description', 'Children deliver the outcome.']).status, 0);
    const check = run(dir, ['change', 'add', 'epic', 'check', '--id', 'C1', '--description', 'Acceptance', '--kind', 'command', '--command', 'node -e "process.exit(0)"', '--requirement', 'R1']);
    assert.equal(check.status, 0, check.stderr);

    const validated = run(dir, ['validate', 'epic', '--json']);
    assert.equal(validated.status, 0, validated.stdout);
    const data = JSON.parse(validated.stdout).data;
    assert.equal(data.readiness.ready, true);
    assert.deepEqual(data.readiness.blockers.filter((blocker: { code: string }) => ['missing_tasks', 'uncovered_requirement'].includes(blocker.code)), []);

    const status = run(dir, ['status', 'epic', '--json']);
    assert.equal(status.status, 0, status.stdout);
    const statusData = JSON.parse(status.stdout).data;
    assert.equal(statusData.readiness.ready, true);
    assert.equal(statusData.facets.planning.status, 'ready');
    assert.equal(statusData.facets.localClosure.status, 'open');

    const shown = run(dir, ['change', 'show', 'epic', '--json']);
    assert.equal(shown.status, 0, shown.stdout);
    assert.equal(JSON.parse(shown.stdout).data.readiness.ready, true);

    const leafShown = run(dir, ['change', 'show', 'story', '--json']);
    assert.equal(leafShown.status, 0, leafShown.stdout);
    assert.equal(JSON.parse(leafShown.stdout).data.readiness.ready, false, 'a leaf without tasks must stay not ready');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verify records nested evidence and logs beside the node instead of a flat id', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-tree-verify-'));
  try {
    assert.equal(run(dir, ['init']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Auth', '--as', 'epic']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Login', '--as', 'story', '--parent', 'auth']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Login form', '--as', 'task', '--parent', 'auth/login']).status, 0);
    const leaf = 'auth/login/login-form';
    assert.equal(run(dir, ['change', 'add', leaf, 'requirement', '--id', 'R1', '--title', 'Login works', '--description', 'Login form submits.']).status, 0);
    const check = run(dir, ['change', 'add', leaf, 'check', '--id', 'C1', '--description', 'Node exits zero', '--kind', 'command', '--command', 'node -e "process.exit(0)"', '--requirement', 'R1']);
    assert.equal(check.status, 0, check.stderr);

    const verified = run(dir, ['verify', leaf, '--record', '--json']);
    assert.equal(verified.status, 0, verified.stderr);
    await access(path.join(dir, '.notchlet', 'changes', 'auth', 'login', 'login-form', 'evidence', 'logs'));
    await assert.rejects(access(path.join(dir, '.notchlet', 'changes', 'login-form')));

    const evidence = JSON.parse(run(dir, ['evidence', 'list', '--change', leaf, '--json']).stdout).data.evidence;
    assert.equal(evidence.length, 1);
    assert.match(evidence[0].logPath, /^evidence\/logs\//);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bare rollup nodes close from their children without authored leaf content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-tree-rollup-close-'));
  try {
    assert.equal(run(dir, ['init']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Auth', '--as', 'epic']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Login', '--as', 'story', '--parent', 'auth']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Login form', '--as', 'task', '--parent', 'auth/login']).status, 0);
    const epicState = JSON.parse(await readFile(path.join(dir, '.notchlet', 'changes', 'auth', 'tasks.json'), 'utf8'));
    assert.deepEqual(epicState.checks, [], 'the rollup starts without its own checks');
    assert.deepEqual(epicState.requirements, []);

    const leaf = 'auth/login/login-form';
    assert.equal(run(dir, ['change', 'add', leaf, 'requirement', '--id', 'R1', '--title', 'Login works', '--description', 'Login form submits.']).status, 0);
    assert.equal(run(dir, ['change', 'add', leaf, 'check', '--id', 'C1', '--description', 'Node exits zero', '--kind', 'command', '--command', 'node -e "process.exit(0)"', '--requirement', 'R1']).status, 0);
    assert.equal(run(dir, ['change', 'add', leaf, 'task', '--id', 'T1', '--title', 'Implement login', '--requirement', 'R1']).status, 0);
    assert.equal(run(dir, ['change', 'update', leaf, '--intent', 'Let a user log in.', '--outcome', 'The login form submits successfully.']).status, 0);
    assert.equal(run(dir, ['task', 'start', 'T1', '--change', leaf]).status, 0);
    assert.equal(run(dir, ['task', 'complete', 'T1', '--change', leaf]).status, 0);
    assert.equal(run(dir, ['change', 'render', leaf, '--write']).status, 0);
    assert.equal(run(dir, ['verify', leaf, '--record']).status, 0);

    const gated = run(dir, ['change', 'close', 'auth', '--preview', '--fail-on-blockers', '--json']);
    assert.equal(gated.status, 1);
    const gatedData = JSON.parse(gated.stdout).data;
    assert(gatedData.blockers.some((blocker: { code: string }) => blocker.code === 'child_open'));

    assert.equal(run(dir, ['change', 'close', leaf]).status, 0);
    assert.equal(run(dir, ['change', 'close', 'auth/login']).status, 0);
    const closed = run(dir, ['change', 'close', 'auth', '--json']);
    assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}`);
    assert.equal(JSON.parse(closed.stdout).data.archived, true);
    for (const relative of ['auth', 'auth/login', 'auth/login/login-form']) {
      await access(path.join(dir, '.notchlet', 'archive', relative, 'closure.json'));
    }

    const loginClosure = JSON.parse(await readFile(path.join(dir, '.notchlet', 'archive', 'auth', 'login', 'closure.json'), 'utf8'));
    assert.equal(loginClosure.rollup.children.length, 1);
    assert.equal(loginClosure.rollup.children[0].relativePath, leaf);
    assert.equal(loginClosure.rollup.children[0].closureSha256, createHash('sha256').update(await readFile(path.join(dir, '.notchlet', 'archive', leaf, 'closure.json'))).digest('hex'));

    const authClosure = JSON.parse(await readFile(path.join(dir, '.notchlet', 'archive', 'auth', 'closure.json'), 'utf8'));
    assert.equal(authClosure.rollup.children.length, 1);
    assert.equal(authClosure.rollup.children[0].relativePath, 'auth/login');
    assert.match(authClosure.rollup.children[0].closureSha256, /^[a-f0-9]{64}$/);
    assert.equal(authClosure.rollup.children[0].verification.status, 'not_applicable');

    const archivedShow = run(dir, ['change', 'show', 'auth', '--json']);
    assert.equal(archivedShow.status, 0, archivedShow.stdout);
    assert.equal(JSON.parse(archivedShow.stdout).data.readiness.ready, true);

    const archivedValidate = run(dir, ['validate', 'auth', '--json']);
    assert.equal(archivedValidate.status, 0, archivedValidate.stdout);
    assert.equal(JSON.parse(archivedValidate.stdout).data.readiness.ready, true);

    const archivedStatus = run(dir, ['status', 'auth', '--json']);
    assert.equal(archivedStatus.status, 0, archivedStatus.stdout);
    const archivedState = JSON.parse(archivedStatus.stdout).data;
    assert.equal(archivedState.readiness.ready, true);
    assert.equal(archivedState.facets.planning.status, 'ready');
    assert.equal(archivedState.facets.localClosure.status, 'closed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verify --tree runs open nodes bottom-up, records per-node evidence, and aggregates failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-verify-tree-'));
  try {
    assert.equal(run(dir, ['init']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Auth', '--as', 'epic']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Login', '--as', 'story', '--parent', 'auth']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Login form', '--as', 'task', '--parent', 'auth/login']).status, 0);
    const leaf = 'auth/login/login-form';

    const empty = run(dir, ['verify', 'auth', '--tree', '--json']);
    assert.equal(empty.status, 2);
    assert.equal(JSON.parse(empty.stdout).error.code, 'no_check_commands');

    const unsupported = run(dir, ['verify', 'auth', '--tree', '--check', 'C1', '--json']);
    assert.equal(unsupported.status, 64);
    assert.match(JSON.parse(unsupported.stdout).error.message, /--check cannot be combined with --tree/);

    assert.equal(run(dir, ['change', 'add', leaf, 'check', '--id', 'LEAF-OK', '--description', 'Leaf passes', '--kind', 'command', '--command', 'node -e "process.exit(0)"']).status, 0);
    assert.equal(run(dir, ['change', 'add', 'auth/login', 'check', '--id', 'STORY-OK', '--description', 'Rollup check passes', '--kind', 'command', '--command', 'node -e "process.exit(0)"']).status, 0);

    const passed = run(dir, ['verify', 'auth', '--tree', '--record', '--json']);
    assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
    const passedData = JSON.parse(passed.stdout).data;
    assert.equal(passedData.result, 'passed');
    assert.deepEqual(passedData.totals, { nodes: 2, passed: 2, failed: 0, skipped: 1 });
    assert.deepEqual(passedData.tree.map((entry: any) => entry.relativePath), [leaf, 'auth/login'], 'children verify before their parent');
    assert.deepEqual(passedData.order, [leaf, 'auth/login']);
    assert.equal(passedData.observationBasis, 'artifact');
    assert.ok(passedData.tree.every((entry: any) => entry.observationBasis === 'artifact'));
    assert.ok(passedData.tree.every((entry: any) => /^[0-9a-f-]{36}$/.test(entry.evidenceId)));
    assert(passedData.skipped.some((entry: any) => entry.relativePath === 'auth' && entry.reason === 'no runnable checks'));

    const passedText = run(dir, ['verify', 'auth', '--tree']);
    assert.equal(passedText.status, 0, passedText.stderr);
    assert.match(passedText.stdout, /Run order: auth\/login\/login-form -> auth\/login/);
    assert.match(passedText.stdout, /Observation basis: artifact/);
    assert.match(passedText.stdout, /bare rollups/);

    assert.equal(run(dir, ['change', 'add', leaf, 'check', '--id', 'LEAF-FAIL', '--description', 'Leaf fails', '--kind', 'command', '--command', 'node -e "process.exit(1)"']).status, 0);
    const failed = run(dir, ['verify', 'auth', '--tree', '--json']);
    assert.equal(failed.status, 1);
    const failedData = JSON.parse(failed.stdout).data;
    assert.equal(failedData.result, 'failed');
    assert.deepEqual(failedData.totals, { nodes: 2, passed: 1, failed: 1, skipped: 1 });
    assert.equal(failedData.tree.find((entry: any) => entry.relativePath === leaf).failed, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verify --tree names failed checks, assertions, phase, log, and recovery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-tree-failure-detail-'));
  let probe: ReturnType<typeof spawn> | undefined;
  try {
    const port = await freePort();
    await writeFile(path.join(dir, 'probe-server.mjs'), `import { createServer } from 'node:http';
createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.end('{"ok":false}');
}).listen(${port}, '127.0.0.1', () => console.log('ready'));
`);
    probe = spawn(process.execPath, ['probe-server.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      probe!.stdout!.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
      probe!.on('exit', code => reject(new Error(`probe server exited with ${code}`)));
    });

    assert.equal(run(dir, ['init']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Diagnostic tree', '--as', 'epic']).status, 0);
    const added = run(dir, ['change', 'add', 'diagnostic-tree', 'check', '--id', 'CHECK-ASSERT', '--description', 'JSON must match', '--kind', 'http', '--url', `http://127.0.0.1:${port}/probe`, '--expected-json-at', '{"path":"$.ok","equals":true}']);
    assert.equal(added.status, 0, added.stderr);

    const failed = run(dir, ['verify', 'diagnostic-tree', '--tree', '--record', '--json']);
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    const entry = JSON.parse(failed.stdout).data.tree[0];
    assert.equal(entry.outcome, 'failed');
    assert.equal(entry.failurePhase, 'checks');
    assert.equal(entry.failedChecks[0].id, 'CHECK-ASSERT');
    assert.equal(entry.failedChecks[0].kind, 'http');
    assert.equal(entry.failedChecks[0].assertions[0].kind, 'json-path');
    assert.equal(entry.failedChecks[0].assertions[0].path, '$.ok');
    assert.equal(entry.failedChecks[0].assertions[0].expected, 'equals true');
    assert.equal(entry.failedChecks[0].assertions[0].observed, 'false');
    assert.match(entry.logPath, /^\.notchlet\/changes\/diagnostic-tree\/evidence\/logs\//);
    assert.match(entry.recovery, /notchlet verify diagnostic-tree --check CHECK-ASSERT --record/);

    const text = run(dir, ['verify', 'diagnostic-tree', '--tree', '--record']);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /failed check CHECK-ASSERT \[http\]/);
    assert.match(text.stdout, /assert json-path \$\.ok: expected equals true, observed false/);
    assert.match(text.stdout, /failure phase checks/);
    assert.match(text.stdout, /log \.notchlet\/changes\/diagnostic-tree\/evidence\/logs\//);
    assert.match(text.stdout, /recovery notchlet verify diagnostic-tree --check CHECK-ASSERT --record/);
  } finally {
    if (probe) {
      probe.kill();
      if (probe.exitCode === null) await once(probe, 'exit').catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('verify --tree on an archived subtree points to restore instead of adding a check', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-tree-archived-recovery-'));
  try {
    assert.equal(run(dir, ['init']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Archive probe', '--as', 'epic']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Only story', '--as', 'story', '--parent', 'archive-probe']).status, 0);
    assert.equal(run(dir, ['change', 'new', 'Only task', '--as', 'task', '--parent', 'archive-probe/only-story']).status, 0);
    const leaf = 'archive-probe/only-story/only-task';
    assert.equal(run(dir, ['change', 'add', leaf, 'requirement', '--id', 'R1', '--title', 'Works', '--description', 'The task works.']).status, 0);
    assert.equal(run(dir, ['change', 'add', leaf, 'check', '--id', 'C1', '--description', 'Node exits zero', '--kind', 'command', '--command', 'node -e "process.exit(0)"', '--requirement', 'R1']).status, 0);
    assert.equal(run(dir, ['change', 'add', leaf, 'task', '--id', 'T1', '--title', 'Do it', '--requirement', 'R1']).status, 0);
    assert.equal(run(dir, ['change', 'update', leaf, '--intent', 'Do the work.', '--outcome', 'The work is done.']).status, 0);
    assert.equal(run(dir, ['task', 'start', 'T1', '--change', leaf]).status, 0);
    assert.equal(run(dir, ['task', 'complete', 'T1', '--change', leaf]).status, 0);
    assert.equal(run(dir, ['change', 'render', leaf, '--write']).status, 0);
    assert.equal(run(dir, ['verify', leaf, '--record']).status, 0);
    assert.equal(run(dir, ['change', 'close', leaf]).status, 0);
    assert.equal(run(dir, ['change', 'close', 'archive-probe/only-story']).status, 0);
    assert.equal(run(dir, ['change', 'close', 'archive-probe']).status, 0);

    const archived = run(dir, ['verify', 'archive-probe', '--tree', '--json']);
    assert.equal(archived.status, 2);
    const error = JSON.parse(archived.stdout).error;
    assert.equal(error.code, 'no_open_nodes');
    assert.match(error.message, /all 3 nodes in the subtree are archived/);
    assert.match(error.recovery, /notchlet change restore archive-probe/);

    const nested = run(dir, ['verify', 'archive-probe/only-story', '--tree', '--json']);
    assert.equal(nested.status, 2);
    const nestedError = JSON.parse(nested.stdout).error;
    assert.equal(nestedError.code, 'no_open_nodes');
    assert.match(nestedError.recovery, /notchlet change restore archive-probe\b/);
    assert.doesNotMatch(nestedError.recovery, /change restore archive-probe\/only-story/);

    const text = run(dir, ['verify', 'archive-probe', '--tree']);
    assert.equal(text.status, 2);
    assert.match(`${text.stdout}\n${text.stderr}`, /change restore archive-probe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

