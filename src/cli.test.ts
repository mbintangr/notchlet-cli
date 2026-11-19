import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendEvidence, CORE_VERSION, parseCliJsonEnvelope } from '@notchlet/core';
import { authCommand, type CredentialStore } from './auth.js';


function npm(args: string[], cwd?: string) {
  if (process.platform === 'win32') {
    const command = `npm.cmd ${args.join(' ')}`;
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', command], { cwd, encoding: 'utf8' });
  }
  return spawnSync('npm', args, { cwd, encoding: 'utf8' });
}

test('uninitialized status is successful and has no workspace side effect', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-'));
  try {
    const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
    const result = spawnSync(process.execPath, [cli, 'status', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).data.workspace, null);
    assert.equal(JSON.parse(result.stdout).data.coreVersion, CORE_VERSION);
    assert.doesNotMatch(result.stdout, /\.notchlet/);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(envelope), ['protocolVersion', 'command', 'ok', 'data', 'error', 'warnings']);
    assert.equal(envelope.protocolVersion, 1);
    assert.deepEqual(parseCliJsonEnvelope(envelope), envelope);
    const emptyList = spawnSync(process.execPath, [cli, 'change', 'list', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(emptyList.status, 0);
    assert.deepEqual(JSON.parse(emptyList.stdout).data.changes, []);
    const create = spawnSync(process.execPath, [cli, 'change', 'new', 'No Workspace', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(create.status, 2);
    assert.equal(JSON.parse(create.stdout).error.code, 'setup_required');
    await assert.rejects(access(path.join(dir, '.notchlet')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('init is repeatable and installed CLI handles working paths containing spaces', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet cli test '));
  const dir = path.join(parent, 'project with spaces');
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  try {
    const first = spawnSync(process.execPath, [cli, 'init', dir, '--json'], { encoding: 'utf8' });
    const second = spawnSync(process.execPath, [cli, 'init', dir, '--json'], { encoding: 'utf8' });
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(JSON.parse(second.stdout).ok, true);
    const created = spawnSync(process.execPath, [cli, 'change', 'new', 'With spaces', '--quick', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(created.status, 0);
    const envelope = JSON.parse(created.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.id, 'with-spaces');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('client guidance CLI previews install, applies safely, and reports local edits as conflicts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet client guidance '));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run(['init']).status, 0);
    const config = path.join(dir, '.opencode', 'config.json');
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, '{"mcp":{"preserve":{"url":"https://example.test"}}}\n');
    const preview = run(['client', 'init', 'opencode', '--json']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).data.action, 'install');
    assert.equal(JSON.parse(preview.stdout).data.applied, false);
    const target = path.join(dir, '.opencode', 'skills', 'notchlet-super', 'SKILL.md');
    await assert.rejects(readFile(target));

    const applied = run(['client', 'init', 'opencode', '--apply', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).data.applied, true);
    assert.match(await readFile(target, 'utf8'), /state-aware router/);
    assert.equal((await readFile(config, 'utf8')).includes('preserve'), true);

    await writeFile(target, `${await readFile(target, 'utf8')}\n# User edit\n`);
    const conflict = run(['client', 'update', 'opencode', '--apply', '--json']);
    assert.equal(conflict.status, 0, conflict.stderr);
    assert.equal(JSON.parse(conflict.stdout).data.action, 'conflict');
    assert.match(await readFile(target, 'utf8'), /User edit/);
    assert.equal((await readFile(config, 'utf8')).includes('preserve'), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI change reads use the v1 parser and emit stable version/schema errors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet parser cli '));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  try {
    assert.equal(spawnSync(process.execPath, [cli, 'init'], { cwd: dir }).status, 0);
    const created = spawnSync(process.execPath, [cli, 'change', 'new', 'Parser check', '--quick', '--json'], { cwd: dir, encoding: 'utf8' });
    const id = JSON.parse(created.stdout).data.id as string;
    const tasks = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');
    await writeFile(tasks, '{"schemaVersion":2}');
    const unsupported = spawnSync(process.execPath, [cli, 'status', id, '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(unsupported.status, 1);
    const unsupportedEnvelope = parseCliJsonEnvelope(JSON.parse(unsupported.stdout));
    assert.equal(unsupportedEnvelope.error?.code, 'unsupported_version');
    assert.match(unsupportedEnvelope.error?.recovery ?? '', /version 1/);
    await writeFile(tasks, '{"schemaVersion":1,"id":"incomplete"}');
    const malformedSchema = spawnSync(process.execPath, [cli, 'status', id, '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(parseCliJsonEnvelope(JSON.parse(malformedSchema.stdout)).error?.code, 'invalid_schema');
    await writeFile(tasks, '{');
    const malformedJson = spawnSync(process.execPath, [cli, 'status', id, '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(parseCliJsonEnvelope(JSON.parse(malformedJson.stdout)).error?.code, 'malformed_json');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('status, validate, and action-specific instructions expose one versioned JSON envelope without prompting', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-facets-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
  try {
    assert.equal(run(['init']).status, 0);
    const created = run(['change', 'new', 'Facet change', '--quick']);
    const id = JSON.parse(created.stdout).data.id as string;
    const status = run(['status', id]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.trim().split(/\r?\n/).length, 1);
    const statusEnvelope = parseCliJsonEnvelope(JSON.parse(status.stdout));
    assert.equal(statusEnvelope.protocolVersion, 1);
    assert.equal((statusEnvelope.data as any).coreVersion, CORE_VERSION);
    assert.equal((statusEnvelope.data as any).facets.planning.status, 'blocked');
    const validated = run(['validate', id]);
    assert.equal(validated.status, 1);
    assert.equal(parseCliJsonEnvelope(JSON.parse(validated.stdout)).error?.code, 'validation_failed');
    const instructed = run(['instructions', id, '--action', 'implement']);
    assert.equal(instructed.status, 0, instructed.stderr);
    assert.equal((JSON.parse(instructed.stdout).data as any).action, 'implement');
    assert.equal((JSON.parse(instructed.stdout).data as any).coreVersion, CORE_VERSION);
    assert.match((JSON.parse(instructed.stdout).data as any).instructions, /dependency-eligible tasks/);
    const badAction = run(['instructions', id, '--action', 'publish']);
    assert.equal(badAction.status, 64);
    assert.equal(parseCliJsonEnvelope(JSON.parse(badAction.stdout)).error?.code, 'usage_error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('change close --preview is read-only and close requires an explicit baseline revision', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-close-cli-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run(['init']).status, 0);
    const created = run(['change', 'new', 'Close preview', '--quick']);
    const id = JSON.parse(created.stdout).data.id as string;
    const preview = run(['change', 'close', id, '--preview']);
    assert.equal(preview.status, 0, preview.stderr);
    assert(JSON.parse(preview.stdout).data.blockers.some((blocker: { code: string }) => blocker.code === 'capability_impact_required'));
    await assert.rejects(readFile(path.join(dir, '.notchlet', 'archive', id)));
    const missingRevision = run(['change', 'close', id]);
    assert.equal(missingRevision.status, 64);
    assert.equal(JSON.parse(missingRevision.stdout).error.code, 'usage_error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('change close applies the previewed baseline revision and archives the accepted change', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-close-cli-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
  try {
    await writeFile(path.join(dir, '.gitignore'), '.notchlet/\n');
    const git = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr);
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await writeFile(path.join(dir, 'tracked.txt'), 'baseline\n');
    spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: dir });
    const commit = spawnSync('git', ['commit', '-m', 'baseline'], { cwd: dir, encoding: 'utf8' }); assert.equal(commit.status, 0, commit.stderr);
    assert.equal(run(['init']).status, 0);
    const created = run(['change', 'new', 'Ready to close', '--quick']);
    const id = JSON.parse(created.stdout).data.id as string;
    const statePath = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');
    const change = JSON.parse(await readFile(statePath, 'utf8'));
    Object.assign(change, {
      capabilityName: 'cli-capability', baselineRevision: 0, capabilityImpact: 'none', capabilityRationale: 'No durable behavior changed.',
      intent: 'Preserve existing behavior', outcome: 'Acceptance check passes',
      requirements: [{ id: 'REQ-1', title: 'Requirement', description: 'Existing capability remains available.' }],
      checks: [{ id: 'CHECK-1', description: 'Run required acceptance.' }],
      tasks: [{ id: 'TASK-1', title: 'Complete task', status: 'completed', dependencies: [], requirementIds: ['REQ-1'] }],
    });
    await writeFile(statePath, JSON.stringify(change, null, 2));
    await appendEvidence(dir, id, { kind: 'check', outcome: 'passed', summary: 'Acceptance passed', requirementIds: ['REQ-1'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const capabilities = path.join(dir, '.notchlet', 'capabilities');
    await mkdir(capabilities, { recursive: true });
    await writeFile(path.join(capabilities, 'cli-capability.yaml'), JSON.stringify({
      schemaVersion: 1, name: 'cli-capability', revision: 0,
      requirements: [{ value: { id: 'REQ-1', title: 'Requirement', description: 'Existing capability remains available.' }, provenance: { changeId: 'prior-change', revision: 1, acceptedAt: '2026-01-01T00:00:00Z', rationale: 'Previously accepted.' } }],
      scenarios: [],
    }));
    const preview = run(['change', 'close', id, '--preview']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout).data.blockers, []);
    const closed = run(['change', 'close', id, '--baseline-revision', '0']);
    assert.equal(closed.status, 0, `${closed.stderr}\n${closed.stdout}`);
    assert.equal(JSON.parse(closed.stdout).data.baselineRevision, 1);
    assert.equal(JSON.parse(await readFile(path.join(dir, '.notchlet', 'capabilities', 'cli-capability.yaml'), 'utf8')).revision, 1);
    await access(path.join(dir, '.notchlet', 'archive', id, 'tasks.json'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('task start and complete subcommands use expected revisions and preserve the explicit update form', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-task-actions-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
  try {
    assert.equal(run(['init', '--local']).status, 0);
    const created = run(['change', 'new', 'Task commands', '--quick']);
    const changeId = JSON.parse(created.stdout).data.id as string;
    const tasksFile = path.join(dir, '.notchlet', 'changes', changeId, 'tasks.json');
    const change = JSON.parse(await readFile(tasksFile, 'utf8'));
    change.revision = 5;
    change.requirements = [{ id: 'REQ-1', title: 'Requirement', description: 'A required behavior.' }];
    change.checks = [{ id: 'CHECK-1', description: 'Run the focused check.' }];
    change.tasks = [{ id: 'TASK-1', title: 'Implement behavior', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] }];
    await writeFile(tasksFile, JSON.stringify(change, null, 2));

    const started = run(['task', 'start', 'TASK-1', '--change', changeId, '--revision', '5']);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).data.revision, 6);
    assert.equal(JSON.parse(await readFile(tasksFile, 'utf8')).tasks[0].status, 'in_progress');

    const completed = run(['task', 'complete', 'TASK-1', '--change', changeId, '--revision', '6']);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).data.revision, 7);
    assert.equal(JSON.parse(await readFile(tasksFile, 'utf8')).tasks[0].status, 'completed');

    const legacyUpdate = run(['task', 'update', changeId, 'TASK-1', 'pending', '7']);
    assert.equal(legacyUpdate.status, 0, legacyUpdate.stderr);
    assert.equal(JSON.parse(legacyUpdate.stdout).data.revision, 8);
    const stale = run(['task', 'complete', 'TASK-1', '--change', changeId, '--revision', '7']);
    assert.notEqual(stale.status, 0);
    assert.equal(JSON.parse(stale.stdout).error.code, 'revision_conflict');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('evidence record CLI accepts file-based checkIds without executing descriptive commands', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet evidence record '));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', timeout: 5000 });
  try {
    assert.equal(run(['init', '--local']).status, 0);
    const created = run(['change', 'new', 'Evidence command', '--quick']);
    const changeId = JSON.parse(created.stdout).data.id as string;
    const stateFile = path.join(dir, '.notchlet', 'changes', changeId, 'tasks.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    state.requirements = [{ id: 'REQ-1', title: 'Requirement', description: 'Required behavior.' }];
    state.checks = [{ id: 'CHECK-1', description: 'Run the unit suite.' }];
    state.tasks = [{ id: 'TASK-1', title: 'Implement', status: 'completed', dependencies: [], requirementIds: ['REQ-1'] }];
    await writeFile(stateFile, JSON.stringify(state, null, 2));
    const inputPath = path.join(dir, 'check result.json');
    await writeFile(inputPath, JSON.stringify({ kind: 'check', outcome: 'passed', summary: 'Unit suite passed', command: 'this is descriptive only', requirementIds: ['REQ-1'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' }));

    const recorded = run(['evidence', 'record', '--change', changeId, '--file', inputPath]);
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.deepEqual(JSON.parse(recorded.stdout).data.checkIds, ['CHECK-1']);
    assert.equal((await readFile(path.join(dir, '.notchlet', 'changes', changeId, 'evidence.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.equal(await access(path.join(dir, 'this is descriptive only')).then(() => true, () => false), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('profile use selects a server from NOTCHLET_CONFIG_DIR without exposing credentials or removing other profiles', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet profile use '));
  const config = path.join(parent, 'user config'), cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = config; delete process.env.NOTCHLET_TOKEN;
  const credentials = new Map<string, string>();
  const store: CredentialStore = {
    name: 'test OS store',
    async get(key) { return credentials.get(key); },
    async set(key, token) { credentials.set(key, token); },
    async delete(key) { credentials.delete(key); },
  };
  try {
    await authCommand('login', { server: 'https://alpha.example', token: 'secret-alpha', store });
    await authCommand('login', { server: 'https://beta.example', token: 'secret-beta', store });
    const childEnv = { ...process.env, NOTCHLET_CONFIG_DIR: config };
    const switched = spawnSync(process.execPath, [cli, 'profile', 'use', '--server', 'https://alpha.example', '--json'], { cwd: parent, env: childEnv, encoding: 'utf8' });
    assert.equal(switched.status, 0, `${switched.stderr}\n${switched.stdout}`);
    assert.doesNotMatch(`${switched.stdout}\n${switched.stderr}`, /secret-alpha|secret-beta/);
    const result = JSON.parse(switched.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.data.profile.origin, 'https://alpha.example');
    assert.equal(result.data.current, true);
    const saved = JSON.parse(await readFile(path.join(config, 'profiles.json'), 'utf8'));
    assert.equal(saved.profiles[saved.current].origin, 'https://alpha.example');
    assert.equal(Object.keys(saved.profiles).length, 2);
    assert.equal(Object.values(saved.profiles).some((profile: any) => profile.origin === 'https://beta.example'), true);
    assert.doesNotMatch(await readFile(path.join(config, 'profiles.json'), 'utf8'), /secret-alpha|secret-beta/);
  } finally {
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(parent, { recursive: true, force: true });
  }
});

test('change list/show honor nearest and explicit workspaces and conversion preserves change content', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet command paths '));
  const outer = path.join(parent, 'outer workspace');
  const nested = path.join(outer, 'nested workspace');
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[], cwd: string) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8' });
  try {
    assert.equal(run(['init', outer], parent).status, 0);
    const outerCreated = run(['change', 'new', 'Outer change', '--quick'], outer);
    const outerId = JSON.parse(outerCreated.stdout).data.id as string;
    assert.equal(run(['init', nested], outer).status, 0);
    const nestedCreated = run(['change', 'new', 'Nested change', '--quick'], nested);
    const nestedId = JSON.parse(nestedCreated.stdout).data.id as string;

    const nearestList = run(['change', 'list'], nested);
    assert.deepEqual(JSON.parse(nearestList.stdout).data.changes.map((change: { id: string }) => change.id), [nestedId]);
    const explicitList = run(['change', 'list', '--workspace', outer], nested);
    assert.deepEqual(JSON.parse(explicitList.stdout).data.changes.map((change: { id: string }) => change.id), [outerId]);
    const scaffoldShow = run(['change', 'show', nestedId], nested);
    assert.equal(scaffoldShow.status, 0, `${scaffoldShow.stderr}\n${scaffoldShow.stdout}`);
    assert.equal(JSON.parse(scaffoldShow.stdout).data.readiness.ready, false);

    const statePath = path.join(nested, '.notchlet', 'changes', nestedId, 'tasks.json');
    const userArtifact = path.join(nested, '.notchlet', 'changes', nestedId, 'notes.md');
    const current = JSON.parse(await readFile(statePath, 'utf8'));
    const authored = { ...current, intent: 'Keep my intent', outcome: 'Retain all progress', revision: 12, baselineRevision: 0, capabilityImpact: 'none', capabilityRationale: 'Keep the existing capability baseline unchanged.', requirements: [{ id: 'REQ-KEEP', title: 'Keep requirement', description: 'Keep identity' }], acceptanceScenarios: [{ id: 'SCENARIO-KEEP', requirementId: 'REQ-KEEP', when: 'When converted', then: 'Then progress remains' }], designDecisions: [{ id: 'DECISION-KEEP', decision: 'Preserve the user content', rationale: 'Conversions must not rewrite authored work' }], checks: [{ id: 'CHECK-KEEP', description: 'Keep checks' }], tasks: [{ id: 'TASK-KEEP', title: 'Done task', status: 'completed', dependencies: [], requirementIds: ['REQ-KEEP'] }], artifacts: { ...current.artifacts, 'notes.md': 'notes.md' } };
    await writeFile(statePath, JSON.stringify(authored, null, 2));
    await writeFile(userArtifact, 'never overwrite me\n');

    const standardResult = run(['change', 'convert', nestedId, '--schema', 'standard'], nested);
    assert.equal(standardResult.status, 0);
    const standard = JSON.parse(standardResult.stdout).data.change;
    assert.equal(standard.mode, 'standard');
    assert.equal(standard.revision, 12);
    assert.deepEqual(standard.tasks, authored.tasks);
    assert.deepEqual(standard.requirements, authored.requirements);
    assert.deepEqual(standard.acceptanceScenarios, authored.acceptanceScenarios);
    assert.deepEqual(standard.designDecisions, authored.designDecisions);
    assert.equal(await readFile(userArtifact, 'utf8'), 'never overwrite me\n');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).intent, 'Keep my intent');

    const quickResult = run(['change', 'convert', nestedId, '--schema=quick'], nested);
    assert.equal(quickResult.status, 0);
    const quick = JSON.parse(quickResult.stdout).data.change;
    assert.equal(quick.mode, 'quick');
    assert.deepEqual(quick.tasks, authored.tasks);
    assert.deepEqual(quick.requirements, authored.requirements);
    assert.deepEqual(quick.acceptanceScenarios, authored.acceptanceScenarios);
    assert.deepEqual(quick.designDecisions, authored.designDecisions);
    assert.deepEqual(quick.artifacts, standard.artifacts);
    assert.equal(await readFile(userArtifact, 'utf8'), 'never overwrite me\n');
    const show = run(['change', 'show', nestedId], nested);
    assert.equal(JSON.parse(show.stdout).data.readiness.ready, true);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('workspace bind CLI uses the nearest nested workspace unless --workspace selects an explicit root', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet bind command '));
  const outer = path.join(parent, 'outer'), nested = path.join(outer, 'nested');
  const config = path.join(parent, 'config'), cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const oldConfig = process.env.NOTCHLET_CONFIG_DIR, oldToken = process.env.NOTCHLET_TOKEN;
  process.env.NOTCHLET_CONFIG_DIR = config; process.env.NOTCHLET_TOKEN = 'binding-command-local-token';
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', () => {
      const message = JSON.parse(body), id = message.id;
      if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      let result: any;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'cli-binding-mock', version: '1.0.0' } };
       else if (message.method === 'tools/list') result = { tools: ['workspace_context', 'product_get_details', 'backlog_list', 'backlog_get', 'backlog_development_context'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) };
      else if (message.method === 'tools/call') {
        const { name, arguments: args = {} } = message.params;
         const value = name === 'workspace_context' ? [{ id: 3, teams: [{ products: [{ id: 31 }] }] }]
           : name === 'product_get_details' ? { id: 31 }
           : name === 'backlog_list' ? [{ id: 55, productId: 31 }]
           : name === 'backlog_get' ? { id: Number(args.itemId), productId: 31, title: 'Packed import fixture', description: 'Packed CLI import acceptance.', acceptanceCriteria: ['Preserve the selected item description.'] }
           : { itemId: Number(args.itemId), section: args.section ?? 'repositories', items: args.section === 'item' ? [{ summary: 'Selected-item context' }] : [{ id: 7, provider: 'GITHUB', repoOwner: 'example', repoName: 'repo', serverUrl: null }], nextCursor: null };
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const preload = path.join(parent, 'fetch-mock.mjs');
  await writeFile(preload, `const nativeFetch = globalThis.fetch.bind(globalThis); globalThis.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); if (url.href === 'https://cli-bind.example/development/v1/capabilities') return new Response(JSON.stringify({ server: { id: 'cli-bind-server', version: '1.0.0' }, protocol: { minimum: '1.0', maximum: '1.0' }, versions: { core: '1.0.0', schema: '1.0.0' }, operations: ['read'] }), { headers: { 'content-type': 'application/json' } }); return nativeFetch(input, init); };\n`);
  const cliEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(pathToFileURL(preload).href)}` };
  const runCli = (args: string[], cwd: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: cliEnv });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  try {
    await authCommand('login', { server: 'https://cli-bind.example', json: true });
    for (const root of [outer, nested]) {
      const init = spawnSync(process.execPath, [cli, 'init', root], { cwd: parent, encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
      const git = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr);
      const remote = spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], { cwd: root, encoding: 'utf8' }); assert.equal(remote.status, 0, remote.stderr);
    }
    const bindArgs = ['workspace', 'bind', '--server', 'https://cli-bind.example', '--product-id', '31', '--repository-id', '7', '--endpoint', endpoint, '--json'];
    const nearest = await runCli(bindArgs, nested);
    assert.equal(nearest.status, 0, `${nearest.stderr}\n${nearest.stdout}`);
    assert.equal(JSON.parse(await readFile(path.join(nested, '.notchlet', 'workspace.json'), 'utf8')).binding.gitRoot, nested);
    const explicit = await runCli([...bindArgs, '--workspace', outer], nested);
    assert.equal(explicit.status, 0, `${explicit.stderr}\n${explicit.stdout}`);
    assert.equal(JSON.parse(await readFile(path.join(outer, '.notchlet', 'workspace.json'), 'utf8')).binding.gitRoot, outer);

    const imported = await runCli(['backlog', 'import', '55', '--product-id', '31', '--server', 'https://cli-bind.example', '--endpoint', endpoint, '--json'], nested);
    assert.equal(imported.status, 0, `${imported.stderr}\n${imported.stdout}`);
    const importedChange = JSON.parse(imported.stdout).data.change;
    assert.equal(importedChange.requirements[0].id, 'REQ-ITEM-55');
    assert.equal(importedChange.requirements[0].title, 'Packed import fixture');
    assert.match(await readFile(path.join(nested, '.notchlet', 'changes', importedChange.id, 'proposal.md'), 'utf8'), /Packed CLI import acceptance/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldConfig === undefined) delete process.env.NOTCHLET_CONFIG_DIR; else process.env.NOTCHLET_CONFIG_DIR = oldConfig;
    if (oldToken === undefined) delete process.env.NOTCHLET_TOKEN; else process.env.NOTCHLET_TOKEN = oldToken;
    await rm(parent, { recursive: true, force: true });
  }
});

test('packed core and CLI install together and run from an isolated path with spaces', async () => {
  const consumer = await mkdtemp(path.join(os.tmpdir(), 'notchlet packed consumer '));
  const packDir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-packed-artifacts-'));
  const globalPrefix = path.join(os.tmpdir(), `notchlet-global-${Date.now()}`);
  const cliPackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const corePackage = path.resolve(cliPackage, '../notchlet-core');
  try {
    const filenames: string[] = [];
    for (const packageDir of [corePackage, cliPackage]) {
      const packed = npm(['pack', packageDir, '--pack-destination', packDir, '--json']);
      assert.equal(packed.status, 0, `${packed.error ?? ''}\n${packed.stderr}\n${packed.stdout}`);
      const details = JSON.parse(packed.stdout)[0];
      filenames.push(details.filename);
      assert(!details.files.some((entry: { path: string }) => entry.path.includes('.test.')));
    }
    const coreTarball = path.join(packDir, filenames[0]);
    const cliTarball = path.join(packDir, filenames[1]);
    const install = npm(['install', coreTarball, cliTarball], consumer);
    assert.equal(install.status, 0, `${install.error ?? ''}\n${install.stderr}\n${install.stdout}`);
    const installedCli = path.join(consumer, 'node_modules', '@notchlet', 'cli', 'dist', 'cli.js');
    const version = spawnSync(process.execPath, [installedCli, '--version', '--json'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.deepEqual(JSON.parse(version.stdout).data, { version: '0.1.0', coreVersion: '0.1.0' });
    const status = spawnSync(process.execPath, [installedCli, 'status', '--json'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).data.workspace, null);

    const globalInstall = npm(['install', '--global', '--prefix', globalPrefix, coreTarball, cliTarball], consumer);
    assert.equal(globalInstall.status, 0, `${globalInstall.error ?? ''}\n${globalInstall.stderr}\n${globalInstall.stdout}`);
    const globalBin = process.platform === 'win32' ? path.join(globalPrefix, 'notchlet.cmd') : path.join(globalPrefix, 'bin', 'notchlet');
    await access(globalBin);
    const globalVersion = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', globalBin, '--version', '--json'], { cwd: consumer, encoding: 'utf8' })
      : spawnSync(globalBin, ['--version', '--json'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(globalVersion.status, 0, globalVersion.stderr);
    assert.deepEqual(JSON.parse(globalVersion.stdout).data, { version: '0.1.0', coreVersion: '0.1.0' });
  } finally {
    await rm(consumer, { recursive: true, force: true });
    await rm(packDir, { recursive: true, force: true });
    await rm(globalPrefix, { recursive: true, force: true });
  }
});

test('interactive setup in the CLI process selects catalog entries using isolated terminal and keyring fixtures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet interactive process '));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const preload = path.join(root, 'terminal-fixture.mjs');
  const config = path.join(root, 'config');
  try {
    for (const args of [['init'], ['remote', 'add', 'origin', 'https://github.com/example/repo.git']]) {
      const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(git.status, 0, git.stderr);
    }
    await writeFile(preload, `
import readline from 'node:readline/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const answers = ['2', 'https://interactive.invalid', 'fixture@example.test', '1', '1', '1', '2'];
readline.createInterface = () => ({ question: async prompt => { process.stderr.write(prompt); if (!answers.length) throw Error('Unexpected prompt'); return answers.shift(); }, close() {} });
syncBuiltinESMExports();
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stderr, 'isTTY', { value: true });
process.stdin.setRawMode = enabled => { if (enabled) setImmediate(() => process.stdin.emit('data', Buffer.from('fixture-password\\r'))); return process.stdin; };
const keyring = 'data:text/javascript,' + encodeURIComponent('const values = new Map(); export class Entry { constructor(service,key) { this.key=service+key; } getPassword(){ return values.get(this.key); } setPassword(value){ values.set(this.key,value); } deletePassword(){ values.delete(this.key); } }');
registerHooks({ resolve(specifier, context, next) { return specifier === '@napi-rs/keyring' ? { url: keyring, shortCircuit: true } : next(specifier, context); } });
globalThis.fetch = async (input, init) => {
 const url = new URL(String(input));
 if (url.origin !== 'https://interactive.invalid') throw Error('External request blocked');
 let value;
 if (url.pathname === '/auth/login') {
   const body=JSON.parse(init.body); if(body.email!=='fixture@example.test'||body.password!=='fixture-password') throw Error('Wrong fixture credentials');
   value={accessToken:'fixture-access',refreshToken:'fixture-refresh',user:{email:body.email}};
 } else if (url.pathname === '/organizations/mine') value=[{id:3,name:'Fixture organization'}];
 else if (url.pathname === '/products') value=[{id:31,name:'Fixture product'}];
 else if (url.pathname === '/products/31') value={id:31};
 else if (url.pathname === '/git/config') value=[{id:7,provider:'GITHUB',repoOwner:'example',repoName:'repo'}];
 else if (url.pathname === '/development/v1/capabilities') value={server:{id:'interactive-server',version:'1.0.0'},protocol:{minimum:'1.0',maximum:'1.0'},versions:{core:'1.0.0',schema:'1.0.0'},operations:['read']};
 else throw Error('Unexpected fixture route '+url.pathname);
 return Response.json(value);
};
`);
    const env: NodeJS.ProcessEnv = { ...process.env, NOTCHLET_CONFIG_DIR: config };
    for (const name of ['NOTCHLET_TOKEN', 'NOTCHLET_EMAIL', 'NOTCHLET_PASSWORD', 'NOTCHLET_SERVER']) delete env[name];
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'init', '--interactive'], { cwd: root, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    assert.equal(workspace.binding.productId, 31);
    assert.equal(workspace.binding.repositoryId, 7);
    assert.equal(workspace.preferences.syncMode, 'manual');
    assert.match(result.stderr, /Organizations:[\s\S]*Products:[\s\S]*Repositories:/);
    assert.doesNotMatch(result.stdout + result.stderr + await readFile(path.join(config, 'profiles.json'), 'utf8'), /fixture-password|fixture-access|fixture-refresh/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packed installed CLI covers offline route families and refuses interactive setup without a TTY', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet packed routes '));
  const config = await mkdtemp(path.join(os.tmpdir(), 'notchlet packed route config '));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const env = { ...process.env, NOTCHLET_CONFIG_DIR: config, NOTCHLET_TOKEN: 'packed-route-token' };
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: root, env, encoding: 'utf8' });
  const envelope = (args: string[], expectedStatus = 0) => {
    const result = run(args);
    assert.equal(result.status, expectedStatus, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(envelope(['init']).ok, true);
    assert.equal(envelope(['auth', 'login', '--server', 'https://packed-route.invalid']).ok, true);
    assert.equal(envelope(['auth', 'status']).ok, true);
    assert.equal(envelope(['auth', 'logout', '--allow-file-token-store']).ok, true);
    assert.equal(envelope(['doctor']).ok, true);
    assert.equal(envelope(['sync', 'mode', 'manual']).ok, true);
    const change = envelope(['change', 'new', 'Packed routes', '--quick']).data.id;
    assert.equal(envelope(['sync', 'status', '--change', change]).ok, true);
    for (const [args, status] of [
      [['sync', 'push', '--change', change], 1],
      [['sync', 'pull', '--change', change], 0],
      [['sync', 'resolve', '--change', change, '--keep-local'], 0],
    ] as const) assert.equal(envelope([...args], status).ok, args[1] === 'pull' || args[1] === 'resolve', `${args.join(' ')} should report its unbound result`);
    assert.equal(envelope(['checkpoint', '--change', change, '--name', 'Packed route'], 1).ok, false);
    assert.equal(envelope(['client', 'init', 'claude']).ok, true);
    assert.equal(envelope(['client', 'update', 'claude']).ok, true);
    const interactive = spawnSync(process.execPath, [cli, 'init', '--interactive'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(interactive.status, 1);
    assert.match(interactive.stdout + interactive.stderr, /terminal|TTY/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  }
});
