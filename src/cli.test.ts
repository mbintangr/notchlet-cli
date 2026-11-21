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
import { callMcpTool } from './integration.js';


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
    assert.deepEqual(JSON.parse(first.stdout).data.localGuidance.written.sort(), ['.notchlet/README.md', 'AGENTS.md', 'PROMPT.md']);
    assert.deepEqual(JSON.parse(second.stdout).data.localGuidance.written, []);
    assert.deepEqual(JSON.parse(second.stdout).data.localGuidance.existing.sort(), ['.notchlet/README.md', 'AGENTS.md', 'PROMPT.md']);
    assert.match(await readFile(path.join(dir, 'AGENTS.md'), 'utf8'), /notchlet instructions <change> --action implement/);
    assert.match(await readFile(path.join(dir, 'PROMPT.md'), 'utf8'), /notchlet verify <change> --record/);
    assert.match(await readFile(path.join(dir, '.notchlet', 'README.md'), 'utf8'), /closure\.json/);
    await writeFile(path.join(dir, 'AGENTS.md'), '# Local agent notes\n');
    const third = spawnSync(process.execPath, [cli, 'init', dir, '--json'], { encoding: 'utf8' });
    assert.equal(third.status, 0);
    assert.deepEqual(JSON.parse(third.stdout).data.localGuidance.existing.sort(), ['.notchlet/README.md', 'AGENTS.md', 'PROMPT.md']);
    assert.equal(await readFile(path.join(dir, 'AGENTS.md'), 'utf8'), '# Local agent notes\n');
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
    assert.match(await readFile(target, 'utf8'), /full-cycle orchestrator/);
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
    const verifyInstructions = run(['instructions', id, '--action', 'verify']);
    assert.equal(verifyInstructions.status, 0, verifyInstructions.stderr);
    const verifyText = (JSON.parse(verifyInstructions.stdout).data as any).instructions as string;
    assert.match(verifyText, /Verification is not applicable until checks are declared/);
    assert.match(verifyText, /## Commands[\s\S]*notchlet change render .* --check/);
    assert.match(verifyText, /## Artifacts\n\n- proposal\.json \[canonical\]: current \(proposal\.json\)\n- tasks\.json \[state\]: present \(tasks\.json\)/);
    const kindHelp = spawnSync(process.execPath, [cli, 'change', 'add', 'my-change', 'check', '--help'], { cwd: dir, encoding: 'utf8' });
    assert.equal(kindHelp.status, 0);
    assert.match(kindHelp.stdout, /notchlet change add <change> check --id <id>/);
    assert.match(kindHelp.stdout, /--command <cmd>/);
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
    const requirement = { id: 'REQ-1', title: 'Requirement', description: 'Existing capability remains available.' };
    const acceptanceScenario = { id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'Acceptance runs', then: 'The capability remains available.' };
    const addedRequirement = { id: 'REQ-2', title: 'Added requirement', description: 'The capability gains a durable behavior.' };
    const addedScenario = { id: 'SCENARIO-2', requirementId: 'REQ-2', when: 'The new behavior runs', then: 'The durable behavior is available.' };
    Object.assign(change, {
      mode: 'standard', capabilityName: 'cli-capability', baselineRevision: 0, capabilityImpact: 'delta', capabilityRationale: 'Adds one durable behavior while preserving the existing capability.',
      intent: 'Extend existing behavior', outcome: 'Acceptance check passes with the added behavior',
      requirements: [requirement, addedRequirement], acceptanceScenarios: [acceptanceScenario, addedScenario],
      capabilityDelta: { operations: [{ operation: 'add', requirementId: 'REQ-2', requirement: addedRequirement, scenarios: [addedScenario], rationale: 'Accept the added behavior.' }] },
      designDecisions: [{ id: 'DECISION-1', decision: 'Add one durable behavior', rationale: 'Only that addition is in scope.' }],
      checks: [{ id: 'CHECK-1', description: 'Run required acceptance.' }],
      tasks: [{ id: 'TASK-1', title: 'Complete task', status: 'completed', dependencies: [], requirementIds: ['REQ-1', 'REQ-2'] }],
      artifacts: { ...change.artifacts, 'design.md': 'design.md' },
    });
    await writeFile(statePath, JSON.stringify(change, null, 2));
    await writeFile(path.join(dir, '.notchlet', 'changes', id, 'design.md'), '# Design\n\nPreserve the existing capability, add the declared behavior, and verify it with the declared check.\n');
    const rendered = run(['change', 'render', id, '--write']);
    assert.equal(rendered.status, 0, rendered.stderr);
    await appendEvidence(dir, id, { kind: 'check', outcome: 'passed', summary: 'Acceptance passed', requirementIds: ['REQ-1', 'REQ-2'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const capabilities = path.join(dir, '.notchlet', 'capabilities');
    await mkdir(capabilities, { recursive: true });
    await writeFile(path.join(capabilities, 'cli-capability.yaml'), JSON.stringify({
      schemaVersion: 1, name: 'cli-capability', revision: 0,
      requirements: [{ value: requirement, provenance: { changeId: 'prior-change', revision: 1, acceptedAt: '2026-01-01T00:00:00Z', rationale: 'Previously accepted.' } }],
      scenarios: [{ value: acceptanceScenario, provenance: { changeId: 'prior-change', revision: 1, acceptedAt: '2026-01-01T00:00:00Z', rationale: 'Previously accepted.' } }],
    }));
    const preview = run(['change', 'close', id, '--preview']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout).data.blockers, []);
    const closed = run(['change', 'close', id, '--baseline-revision', '0']);
    assert.equal(closed.status, 0, `${closed.stderr}\n${closed.stdout}`);
    assert.equal(JSON.parse(closed.stdout).data.baselineRevision, 1);
    assert.equal(JSON.parse(await readFile(path.join(dir, '.notchlet', 'capabilities', 'cli-capability.yaml'), 'utf8')).revision, 1);
    await access(path.join(dir, '.notchlet', 'archive', id, 'tasks.json'));
    const manifest = JSON.parse(await readFile(path.join(dir, '.notchlet', 'archive', id, 'closure.json'), 'utf8'));
    assert.equal(manifest.changeId, id);
    assert.equal(manifest.capability.resultingRevision, 1);
    assert.equal(manifest.verification.status, 'current');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quick no-impact change closes through the CLI without a baseline revision or baseline file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-no-impact-cli-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run(['init']).status, 0);
    const created = run(['change', 'new', 'No impact closure', '--quick']);
    const id = JSON.parse(created.stdout).data.id as string;
    const statePath = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');
    const change = JSON.parse(await readFile(statePath, 'utf8'));
    Object.assign(change, {
      capabilityImpact: 'none', capabilityRationale: 'Documentation-only maintenance with no durable behavior change.',
      intent: 'Maintain behavior', outcome: 'Behavior is unchanged',
      requirements: [{ id: 'REQ-1', title: 'Requirement', description: 'Existing behavior remains.' }],
      checks: [{ id: 'CHECK-1', description: 'Run acceptance check.' }],
      tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-1'] }],
    });
    await writeFile(statePath, JSON.stringify(change, null, 2));
    assert.equal(run(['change', 'render', id, '--write']).status, 0);
    await appendEvidence(dir, id, { kind: 'check', outcome: 'passed', summary: 'Acceptance passed', requirementIds: ['REQ-1'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });

    const before = await readFile(statePath, 'utf8');
    const preview = run(['change', 'close', id, '--preview']);
    assert.equal(preview.status, 0, preview.stderr);
    const previewData = JSON.parse(preview.stdout).data;
    assert.equal(previewData.contribution, 'none');
    assert.deepEqual(previewData.blockers, []);
    assert.equal(previewData.verification.basis, 'artifact');
    assert.equal(await readFile(statePath, 'utf8'), before);

    const humanPreview = spawnSync(process.execPath, [cli, 'change', 'close', id, '--preview'], { cwd: dir, encoding: 'utf8' });
    assert.equal(humanPreview.status, 0, humanPreview.stderr);
    assert.match(humanPreview.stdout, /Capability contribution/);
    assert.match(humanPreview.stdout, /Planning readiness/);
    assert.match(humanPreview.stdout, /Verification/);
    assert.match(humanPreview.stdout, /Local closure/);
    assert.match(humanPreview.stdout, /Remote delivery/);
    assert.match(humanPreview.stdout, /No files were changed/);

    const rejected = run(['change', 'close', id, '--baseline-revision', '0']);
    assert.equal(rejected.status, 64);
    assert.equal(JSON.parse(rejected.stdout).error.code, 'usage_error');

    const closed = run(['change', 'close', id]);
    assert.equal(closed.status, 0, `${closed.stderr}\n${closed.stdout}`);
    assert.equal(JSON.parse(closed.stdout).data.archived, true);
    await access(path.join(dir, '.notchlet', 'archive', id, 'tasks.json'));
    await access(path.join(dir, '.notchlet', 'archive', id, 'closure.json'));
    await assert.rejects(access(path.join(dir, '.notchlet', 'capabilities')));

    const second = JSON.parse(run(['change', 'new', 'Second no impact', '--quick']).stdout).data.id as string;
    const secondPath = path.join(dir, '.notchlet', 'changes', second, 'tasks.json');
    const secondChange = JSON.parse(await readFile(secondPath, 'utf8'));
    Object.assign(secondChange, {
      capabilityImpact: 'none', capabilityRationale: 'No durable behavior change.',
      intent: 'Maintain behavior', outcome: 'Behavior is unchanged',
      requirements: [{ id: 'REQ-2', title: 'Requirement', description: 'Existing behavior remains.' }],
      checks: [{ id: 'CHECK-2', description: 'Run acceptance check.' }],
      tasks: [{ id: 'TASK-2', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-2'] }],
    });
    await writeFile(secondPath, JSON.stringify(secondChange, null, 2));
    assert.equal(run(['change', 'render', second, '--write']).status, 0);
    await appendEvidence(dir, second, { kind: 'check', outcome: 'passed', summary: 'Acceptance passed', requirementIds: ['REQ-2'], taskIds: ['TASK-2'], checkIds: ['CHECK-2'], provenance: 'recorded' });
    const human = spawnSync(process.execPath, [cli, 'change', 'close', second], { cwd: dir, encoding: 'utf8' });
    assert.equal(human.status, 0, `${human.stderr}\n${human.stdout}`);
    assert.match(human.stdout, /Local closure only; remote delivery is unchanged/);
    assert.match(human.stdout, /No capability baseline was written/);
    await assert.rejects(access(path.join(dir, '.notchlet', 'capabilities')));

    const archivedList = JSON.parse(run(['change', 'list', '--archived']).stdout).data;
    assert.deepEqual(archivedList.changes.map((change: { id: string }) => change.id), [id, second].sort());
    assert.equal(archivedList.changes.every((change: { archived: boolean; closedAt: string }) => change.archived && Boolean(change.closedAt)), true);
    const shown = JSON.parse(run(['change', 'show', id]).stdout).data;
    assert.equal(shown.archived, true);
    assert.equal(shown.closure.changeId, id);
    assert.equal(run(['change', 'render', id, '--check']).status, 0);
    const exported = JSON.parse(run(['change', 'export', id, '--format', 'json']).stdout).data;
    assert.equal(exported.archived, true);
    assert.equal(exported.closure.changeId, id);
    assert.equal(exported.evidence.length, 1);
    assert.equal(JSON.parse(exported.contents['proposal.json']).change.id, id);
    const archivedEdit = run(['change', 'update', id, '--intent', 'Changed while archived']);
    assert.notEqual(archivedEdit.status, 0);
    assert.equal(JSON.parse(archivedEdit.stdout).error.code, 'archived_change');

    const restored = run(['change', 'restore', id]);
    assert.equal(restored.status, 0, `${restored.stderr}\n${restored.stdout}`);
    assert.equal(JSON.parse(restored.stdout).data.id, id);
    assert.deepEqual(JSON.parse(run(['change', 'list', '--archived']).stdout).data.changes.map((change: { id: string }) => change.id), [second]);
    assert.equal(JSON.parse(run(['change', 'show', id]).stdout).data.archived, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('non-Git standard change stays blocked until baseline and delta are authored through the CLI', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-capability-loop-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run(['init']).status, 0);
    const created = run(['change', 'new', 'Capability loop']);
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).data.id as string;
    const statePath = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');
    const requirement = { id: 'REQ-LOOP', title: 'Loop behavior', description: 'Durable behavior added by the change.' };
    const acceptanceScenario = { id: 'SCENARIO-LOOP', requirementId: 'REQ-LOOP', when: 'The loop runs', then: 'The behavior is available.' };
    const change = JSON.parse(await readFile(statePath, 'utf8'));
    Object.assign(change, {
      capabilityImpact: 'delta', capabilityRationale: 'Adds durable capability behavior.',
      intent: 'Add behavior', outcome: 'Behavior is available', revision: 1,
      requirements: [requirement], acceptanceScenarios: [acceptanceScenario],
      designDecisions: [{ id: 'DECISION-1', decision: 'Author the delta explicitly', rationale: 'Closure compares stored delta content.' }],
      checks: [{ id: 'CHECK-1', description: 'Run acceptance check.' }],
      tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-LOOP'] }],
    });
    await writeFile(statePath, JSON.stringify(change, null, 2));
    await writeFile(path.join(dir, '.notchlet', 'changes', id, 'design.md'), '# Design\n\nAuthor the new behavior and verify it with the declared check.\n');

    const before = await readFile(statePath, 'utf8');
    const missingBaseline = run(['change', 'close', id, '--preview']);
    assert.equal(missingBaseline.status, 0, missingBaseline.stderr);
    assert.equal(missingBaseline.stdout.includes('baseline_revision_missing'), true);
    assert.equal(await readFile(statePath, 'utf8'), before, 'preview must not change files');

    const captured = spawnSync(process.execPath, [cli, 'change', 'baseline', id, '--capability', 'loop-capability', '--revision', '1'], { cwd: dir, encoding: 'utf8' });
    assert.equal(captured.status, 0, `${captured.stderr}\n${captured.stdout}`);
    assert.match(captured.stdout, /Captured baseline loop-capability at revision 0/);
    const capturedState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(capturedState.revision, 2);
    assert.equal(capturedState.baselineRevision, 0);

    const staleCapture = run(['change', 'baseline', id, '--capability-name', 'loop-capability', '--revision', '1']);
    assert.equal(staleCapture.status, 1);
    assert.equal(JSON.parse(staleCapture.stdout).error.code, 'revision_conflict');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).revision, 2);

    const undeclared = run(['change', 'close', id, '--preview']);
    assert.equal(undeclared.stdout.includes('capability_delta_required'), true);
    assert.equal(undeclared.stdout.includes('undeclared_capability_delta'), true);

    const added = run(['change', 'delta', id, 'add', '--requirement', 'REQ-LOOP', '--rationale', 'Accept the new behavior.', '--revision', '2']);
    assert.equal(added.status, 0, `${added.stderr}\n${added.stdout}`);
    assert.equal(JSON.parse(added.stdout).data.revision, 3);
    const operation = JSON.parse(added.stdout).data.capabilityDelta.operations[0];
    assert.deepEqual(operation.requirement, requirement);
    assert.deepEqual(operation.scenarios, [acceptanceScenario]);
    const duplicate = run(['change', 'delta', id, 'add', '--requirement', 'REQ-LOOP', '--rationale', 'Duplicate.']);
    assert.equal(duplicate.status, 1);
    assert.equal(JSON.parse(duplicate.stdout).error.code, 'duplicate_delta_operation');

    const deleted = run(['change', 'delta', id, 'delete', '--requirement', 'REQ-LOOP', '--revision', '3']);
    assert.equal(deleted.status, 0, `${deleted.stderr}\n${deleted.stdout}`);
    assert.deepEqual(JSON.parse(deleted.stdout).data.capabilityDelta.operations, []);
    const restored = run(['change', 'delta', id, 'add', '--requirement', 'REQ-LOOP', '--rationale', 'Accept the new behavior.', '--revision', '4']);
    assert.equal(restored.status, 0, `${restored.stderr}\n${restored.stdout}`);

    const rendered = run(['change', 'render', id, '--write']);
    assert.equal(rendered.status, 0, rendered.stderr);
    await appendEvidence(dir, id, { kind: 'check', outcome: 'passed', summary: 'Acceptance passed', requirementIds: ['REQ-LOOP'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const status = run(['status', id]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).data.facets.verification.current, ['CHECK-1']);
    assert.deepEqual(JSON.parse(status.stdout).data.facets.verification.unknown, []);
    const ready = run(['change', 'close', id, '--preview']);
    assert.equal(ready.status, 0, ready.stderr);
    const readyData = JSON.parse(ready.stdout).data;
    assert.equal(readyData.contribution, 'delta');
    assert.deepEqual(readyData.blockers, []);
    assert.equal(readyData.verification.basis, 'artifact');
    assert.equal(readyData.additions[0].id, 'REQ-LOOP');

    const closed = run(['change', 'close', id, '--baseline-revision', '0']);
    assert.equal(closed.status, 0, `${closed.stderr}\n${closed.stdout}`);
    assert.equal(JSON.parse(closed.stdout).data.baselineRevision, 1);
    const baseline = JSON.parse(await readFile(path.join(dir, '.notchlet', 'capabilities', 'loop-capability.yaml'), 'utf8'));
    assert.equal(baseline.revision, 1);
    assert.equal(baseline.requirements[0].value.id, 'REQ-LOOP');
    assert.equal(baseline.requirements[0].provenance.changeId, id);
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

    const started = run(['task', 'start', 'Implement behavior', '--change', 'Task commands', '--revision', '5']);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).data.revision, 6);
    assert.equal(JSON.parse(await readFile(tasksFile, 'utf8')).tasks[0].status, 'in_progress');

    const completed = run(['task', 'complete', 'TASK-1', '--change', changeId, '--revision', '6']);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).data.revision, 7);
    assert.equal(JSON.parse(await readFile(tasksFile, 'utf8')).tasks[0].status, 'completed');

    const legacyUpdate = run(['task', 'update', 'Task commands', 'Implement behavior', 'pending', '7']);
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

test('scoped evidence records only linked work, warns or blocks task completion, and reports recovery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-evidence-integrity-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  try {
    assert.equal(run(['init', '--local']).status, 0);
    const created = run(['change', 'new', 'Evidence integrity', '--quick', '--json']);
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).data.id as string;

    for (const requirement of ['REQ-1', 'REQ-2']) assert.equal(run(['change', 'add', id, 'requirement', '--id', requirement, '--title', requirement, '--description', `Behavior ${requirement}`, '--json']).status, 0);
    for (const [task, requirement] of [['TASK-1', 'REQ-1'], ['TASK-2', 'REQ-2']]) assert.equal(run(['change', 'add', id, 'task', '--id', task, '--title', task, '--requirement', requirement, '--json']).status, 0);
    const rejected = run(['change', 'add', id, 'check', '--id', 'CHECK-BAD', '--description', 'Bad link', '--requirement', 'REQ-9', '--json']);
    assert.notEqual(rejected.status, 0);
    assert.equal(JSON.parse(rejected.stdout).error.code, 'unknown_requirement');
    for (const [check, requirement, task] of [['CHECK-1', 'REQ-1', 'TASK-1'], ['CHECK-2', 'REQ-2', 'TASK-2']]) {
      const added = run(['change', 'add', id, 'check', '--id', check, '--description', `Run ${check}`, '--command', 'node --version', '--requirement', requirement, '--task', task, '--json']);
      assert.equal(added.status, 0, added.stderr);
    }
    assert.match(run(['change', 'show', id]).stdout, /verifies requirements REQ-1; tasks TASK-1/);
    const shown = JSON.parse(run(['change', 'show', id, '--json']).stdout).data.change;
    assert.deepEqual(shown.checks.find((check: any) => check.id === 'CHECK-1').requirementIds, ['REQ-1']);
    assert.deepEqual(shown.checks.find((check: any) => check.id === 'CHECK-1').taskIds, ['TASK-1']);

    const usage = run(['verify', id, '--requirement', 'REQ-1', '--json']);
    assert.notEqual(usage.status, 0);
    assert.equal(JSON.parse(usage.stdout).error.code, 'usage_error');
    assert.match(JSON.parse(usage.stdout).error.message, /require --record/);

    const scoped = run(['verify', id, '--check', 'CHECK-1', '--record', '--json']);
    assert.equal(scoped.status, 0, scoped.stderr);
    const scopedEvidence = JSON.parse(scoped.stdout).data.evidence;
    assert.deepEqual(scopedEvidence.checkIds, ['CHECK-1']);
    assert.deepEqual(scopedEvidence.requirementIds, ['REQ-1']);
    assert.deepEqual(scopedEvidence.taskIds, ['TASK-1']);
    assert.match(scopedEvidence.logPath, /^evidence\/logs\/[^/]+\.json$/);
    assert.match(scopedEvidence.logHash, /^[0-9a-f]{64}$/);
    assert.ok(scopedEvidence.logBytes > 0);
    await access(path.join(dir, '.notchlet', 'changes', id, scopedEvidence.logPath));

    const explicit = run(['verify', id, '--check', 'CHECK-2', '--record', '--requirement', 'REQ-1', '--json']);
    assert.equal(explicit.status, 0, explicit.stderr);
    const explicitEvidence = JSON.parse(explicit.stdout).data.evidence;
    assert.deepEqual(explicitEvidence.checkIds, ['CHECK-2']);
    assert.deepEqual(explicitEvidence.requirementIds, ['REQ-2', 'REQ-1']);
    assert.deepEqual(explicitEvidence.taskIds, ['TASK-2']);

    const revised = run(['change', 'update', id, 'requirement', 'REQ-1', '--description', 'Revised behavior REQ-1', '--json']);
    assert.equal(revised.status, 0, revised.stderr);

    assert.equal(run(['task', 'start', 'TASK-2', '--change', id, '--json']).status, 0);
    const warned = run(['task', 'complete', 'TASK-2', '--change', id, '--json']);
    assert.equal(warned.status, 0, warned.stderr);
    const warnedEnvelope = JSON.parse(warned.stdout);
    assert.equal(warnedEnvelope.data.tasks.find((task: any) => task.id === 'TASK-2').status, 'completed');
    assert.equal(warnedEnvelope.warnings[0].code, 'evidence_missing');
    assert.equal(warnedEnvelope.warnings[0].evidenceStatus, 'stale');
    assert.match(warnedEnvelope.warnings[0].recovery, /--task TASK-2/);

    assert.equal(run(['task', 'start', 'TASK-1', '--change', id, '--json']).status, 0);
    const humanWarned = run(['task', 'complete', 'TASK-1', '--change', id]);
    assert.equal(humanWarned.status, 0, humanWarned.stderr);
    assert.match(humanWarned.stdout, /evidence_missing/);
    assert.match(humanWarned.stdout, /Recovery[^\n]*notchlet verify/);

    assert.equal(run(['task', 'start', 'TASK-1', '--change', id, '--json']).status, 0);
    const tasksFile = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');
    const beforeStrict = JSON.parse(await readFile(tasksFile, 'utf8'));
    const strict = run(['task', 'complete', 'TASK-1', '--change', id, '--require-evidence', '--json']);
    assert.notEqual(strict.status, 0);
    const strictEnvelope = JSON.parse(strict.stdout);
    assert.equal(strictEnvelope.error.code, 'evidence_required');
    assert.match(strictEnvelope.error.recovery, /--task TASK-1/);
    const afterStrict = JSON.parse(await readFile(tasksFile, 'utf8'));
    assert.equal(afterStrict.revision, beforeStrict.revision);
    assert.equal(afterStrict.tasks.find((task: any) => task.id === 'TASK-1').status, 'in_progress');

    const filtered = (args: string[]) => JSON.parse(run(['evidence', 'list', '--change', id, ...args, '--json']).stdout).data.evidence;
    assert.equal(filtered(['--check', 'CHECK-1']).length, 1);
    assert.equal(filtered(['--requirement', 'REQ-1']).length, 2);
    assert.equal(filtered(['--task', 'TASK-1']).length, 1);
    assert.equal(filtered(['--task', 'TASK-2']).length, 1);
    assert.equal(filtered(['--failed']).length, 0);
    assert.equal(filtered(['--stale']).length, 2);
    const humanEvidence = run(['evidence', 'list', '--change', id]);
    assert.match(humanEvidence.stdout, /Freshness/);
    assert.match(humanEvidence.stdout, /Recovery for/);

    const status = JSON.parse(run(['status', id, '--json']).stdout).data;
    assert.match(status.recovery, new RegExp(`notchlet verify ${id} --check`));
    assert.match(run(['status', id]).stdout, /Recovery/);

    const preview = JSON.parse(run(['change', 'close', id, '--preview', '--json']).stdout).data;
    assert.match(preview.verification.recovery, new RegExp(`notchlet verify ${id} --check`));
    assert.match(run(['change', 'close', id, '--preview']).stdout, /Verification recovery/);

    assert.equal(run(['change', 'add', id, 'check', '--id', 'CHECK-FAIL', '--description', 'Always fails', '--command', 'node -e "process.exit(1)"', '--requirement', 'REQ-2', '--task', 'TASK-2', '--json']).status, 0);
    const failed = run(['verify', id, '--check', 'CHECK-FAIL', '--record', '--json']);
    assert.equal(failed.status, 1);
    assert.match(JSON.parse(failed.stdout).data.recovery, /notchlet verify .* --check CHECK-FAIL --record/);
    assert.equal(filtered(['--failed']).length, 1);
    assert.match(run(['verify', id, '--check', 'CHECK-FAIL']).stdout, /Recovery[^\n]*notchlet verify/);
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

test('change new --from previews and imports a declarative plan with one revision bump', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-plan-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  try {
    assert.equal(run(['init']).status, 0);
    const planPath = path.join(dir, 'plan.json');
    await writeFile(planPath, JSON.stringify({
      name: 'Planned Notes', mode: 'quick',
      intent: 'Create a notes change from a declarative plan.',
      outcome: 'All authored fields import in a single revision.',
      capabilityImpact: 'none', capabilityRationale: 'No capability contract changes.',
      requirements: [{ id: 'REQ-1', title: 'Plan import', description: 'Import authored content from JSON.' }],
      acceptanceScenarios: [{ id: 'SCN-1', requirementId: 'REQ-1', when: 'a plan is imported', then: 'the change is ready' }],
      checks: [{ id: 'CHK-1', description: 'Plan readiness', command: 'node --version', requirementIds: ['REQ-1'], taskIds: ['TASK-2'] }],
      tasks: [
        { id: 'TASK-2', title: 'Render artifacts', dependencies: ['TASK-1'], requirementIds: ['REQ-1'] },
        { id: 'TASK-1', title: 'Author metadata', requirementIds: ['REQ-1'] },
      ],
    }, null, 2) + '\n');
    const dryRun = run(['change', 'new', '--from', planPath, '--dry-run', '--render']);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const preview = JSON.parse(dryRun.stdout).data;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.change.id, 'planned-notes');
    assert.equal(preview.change.revision, 1);
    assert.equal(preview.readiness.ready, true);
    assert.equal(preview.contents['proposal.json'].includes('Import authored content from JSON.'), true);
    assert.deepEqual(JSON.parse(run(['change', 'list']).stdout).data.changes, []);

    const created = run(['change', 'new', '--from', planPath, '--render']);
    assert.equal(created.status, 0, created.stderr);
    const change = JSON.parse(created.stdout).data;
    assert.equal(change.revision, 1);
    assert.equal(change.contentRevision, 1);
    assert.deepEqual(change.import.written.sort(), ['proposal.json']);
    assert.deepEqual(JSON.parse(run(['change', 'show', 'planned-notes']).stdout).data.change.tasks.map((task: { id: string; status: string }) => [task.id, task.status]), [['TASK-2', 'pending'], ['TASK-1', 'pending']]);
    assert.equal(run(['change', 'render', 'planned-notes', '--check']).status, 0);

    const aliased = run(['change', 'new', 'Different Name', '--from', planPath]);
    assert.equal(aliased.status, 0, aliased.stderr);
    const aliasedData = JSON.parse(aliased.stdout).data;
    assert.equal(aliasedData.id, 'different-name');
    assert.equal(aliasedData.name, 'Different Name');
    const duplicate = run(['change', 'new', '--from', planPath, '--render']);
    assert.equal(duplicate.status, 3);
    assert.equal(JSON.parse(duplicate.stdout).error.code, 'change_exists');
    await writeFile(planPath, '{not json');
    const malformed = run(['change', 'new', '--from', planPath]);
    assert.equal(malformed.status, 1);
    assert.equal(JSON.parse(malformed.stdout).error.code, 'malformed_plan');
  } finally { await rm(dir, { recursive: true, force: true }); }
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
  const backlogItems: any[] = [{ id: 55, productId: 31, parentId: null, itemType: 'STORY', key: 'APP-55', title: 'Packed import fixture', description: 'Packed CLI import acceptance.', acceptanceCriteria: ['Preserve the selected item description.'], status: 'TODO' }];
  let nextBacklogId = 56;
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; req.setEncoding('utf8'); req.on('data', chunk => body += chunk); req.on('end', () => {
      const message = JSON.parse(body), id = message.id;
      if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      let result: any;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'cli-binding-mock', version: '1.0.0' } };
       else if (message.method === 'tools/list') result = { tools: [
         { name: 'workspace_context', description: 'Workspace', inputSchema: { type: 'object', properties: {} } },
         { name: 'product_get_details', description: 'Product', inputSchema: { type: 'object', properties: { productId: { type: 'integer' } }, required: ['productId'] } },
         { name: 'workspace_search', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
         { name: 'backlog_list', description: 'Backlog', inputSchema: { type: 'object', properties: { productId: { type: 'integer' } }, required: ['productId'] } },
         { name: 'backlog_create', description: 'Create backlog item', inputSchema: { type: 'object', properties: { productId: { type: 'integer' }, itemType: { type: 'string' }, title: { type: 'string' }, parentId: { type: 'integer' } }, required: ['productId', 'itemType', 'title'] } },
         { name: 'backlog_get', description: 'Read backlog item', inputSchema: { type: 'object', properties: { itemId: { type: 'integer' } }, required: ['itemId'] } },
         { name: 'backlog_development_context', description: 'Bounded context', inputSchema: { type: 'object', properties: { itemId: { type: 'integer' }, section: { type: 'string' }, limit: { type: 'integer' } }, required: ['itemId'] } },
       ] };
       else if (message.method === 'tools/call') {
         const { name, arguments: args = {} } = message.params;
          const value = name === 'workspace_context' ? [{ id: 3, teams: [{ products: [{ id: 31 }] }] }]
            : name === 'product_get_details' ? { id: 31 }
            : name === 'workspace_search' ? backlogItems.filter(item => `${item.key} ${item.title}`.toLowerCase().includes(String(args.query).toLowerCase()))
            : name === 'backlog_list' ? backlogItems.filter(item => item.productId === Number(args.productId))
            : name === 'backlog_create' ? (() => { const created = { id: nextBacklogId++, productId: Number(args.productId), parentId: Number(args.parentId), itemType: args.itemType, key: `APP-${nextBacklogId - 1}`, title: args.title, description: '', status: 'TODO' }; backlogItems.push(created); return created; })()
            : name === 'backlog_get' ? backlogItems.find(item => item.id === Number(args.itemId))
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
  await writeFile(preload, `const nativeFetch = globalThis.fetch.bind(globalThis); globalThis.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); if (url.href === 'https://cli-bind.example/development/v1/capabilities') return new Response(JSON.stringify({ server: { id: 'cli-bind-server', version: '1.0.0' }, protocol: { minimum: '1.0', maximum: '1.0' }, versions: { core: '1.0.0', schema: '1.0.0' }, operations: ['read'] }), { headers: { 'content-type': 'application/json' } }); if (url.pathname === '/organizations/mine') return Response.json([{id:3,name:'Fixture organization'}]); if (url.href === 'https://cli-bind.example/products?organizationId=3') return Response.json([{id:31,name:'Fixture Product'}]); if (url.href === 'https://cli-bind.example/git/config?productId=31') return Response.json([{id:7,provider:'GITHUB',repoOwner:'example',repoName:'repo',repoLabel:'example/repo'}]); if (url.href === 'https://cli-bind.example/backlog?productId=31') return Response.json([{id:55,productId:31,key:'APP-55',title:'Packed import fixture',status:'TODO'}]); return nativeFetch(input, init); };\n`);
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
    const bindArgs = ['workspace', 'bind', '--server', 'https://cli-bind.example', '--product', 'Fixture Product', '--repository', 'example/repo', '--endpoint', endpoint, '--json'];
    const nearest = await runCli(bindArgs, nested);
    assert.equal(nearest.status, 0, `${nearest.stderr}\n${nearest.stdout}`);
    assert.equal(JSON.parse(await readFile(path.join(nested, '.notchlet', 'workspace.json'), 'utf8')).binding.gitRoot, nested);
    const explicit = await runCli([...bindArgs, '--workspace', outer], nested);
    assert.equal(explicit.status, 0, `${explicit.stderr}\n${explicit.stdout}`);
    assert.equal(JSON.parse(await readFile(path.join(outer, '.notchlet', 'workspace.json'), 'utf8')).binding.gitRoot, outer);

    const toolOptions = { server: 'https://cli-bind.example', endpoint };
    const found = await callMcpTool<any>('workspace_search', { query: 'APP-55' }, toolOptions);
    const foundItems = JSON.parse(found.content.find((part: any) => part.type === 'text').text);
    assert.equal(foundItems[0].title, 'Packed import fixture');
    const createdChild = await callMcpTool<any>('backlog_create', { productId: 31, itemType: 'TASK', title: 'Add fixture verification', parentId: 55 }, toolOptions);
    const childItem = JSON.parse(createdChild.content.find((part: any) => part.type === 'text').text);
    assert.equal(childItem.parentId, 55);
    const verifiedItems = await callMcpTool<any>('backlog_list', { productId: 31 }, toolOptions);
    assert.equal(JSON.parse(verifiedItems.content.find((part: any) => part.type === 'text').text).some((item: any) => item.id === childItem.id && item.parentId === 55), true);

    const imported = await runCli(['backlog', 'import', 'APP-55', '--server', 'https://cli-bind.example', '--endpoint', endpoint, '--json'], nested);
    assert.equal(imported.status, 0, `${imported.stderr}\n${imported.stdout}`);
    const importedChange = JSON.parse(imported.stdout).data.change;
    assert.equal(importedChange.requirements[0].id, 'REQ-ITEM-55');
    assert.equal(importedChange.requirements[0].title, 'Packed import fixture');
    assert.match(await readFile(path.join(nested, '.notchlet', 'changes', importedChange.id, 'proposal.md'), 'utf8'), /Packed CLI import acceptance/);

    const taskStart = await runCli(['task', 'start', 'Implement backlog item 55', '--change', importedChange.name, '--revision', '0', '--json'], nested);
    assert.equal(taskStart.status, 0, `${taskStart.stderr}\n${taskStart.stdout}`);
    assert.equal(JSON.parse(await readFile(path.join(nested, '.notchlet', 'changes', importedChange.id, 'tasks.json'), 'utf8')).tasks[0].status, 'in_progress');
    const taskComplete = await runCli(['task', 'complete', 'Implement backlog item 55', '--change', importedChange.name, '--revision', '1', '--json'], nested);
    assert.equal(taskComplete.status, 0, `${taskComplete.stderr}\n${taskComplete.stdout}`);

    const evidencePath = path.join(nested, 'backlog verification.json');
    await writeFile(evidencePath, JSON.stringify({ kind: 'check', outcome: 'passed', summary: 'Backlog item acceptance was verified.', command: 'mock integration workflow', requirementIds: ['REQ-ITEM-55'], taskIds: ['TASK-ITEM-55'], checkIds: ['CHECK-ITEM-55-1'], provenance: 'recorded' }));
    const evidence = await runCli(['evidence', 'record', '--change', importedChange.name, '--file', evidencePath, '--json'], nested);
    assert.equal(evidence.status, 0, `${evidence.stderr}\n${evidence.stdout}`);
    assert.equal((await readFile(path.join(nested, '.notchlet', 'changes', importedChange.id, 'evidence.jsonl'), 'utf8')).trim().split('\n').length, 1);
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
  const cliPackageVersion = JSON.parse(await readFile(path.join(cliPackage, 'package.json'), 'utf8')).version;
  const corePackageVersion = JSON.parse(await readFile(path.join(corePackage, 'package.json'), 'utf8')).version;
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
    assert.deepEqual(JSON.parse(version.stdout).data, { version: cliPackageVersion, coreVersion: corePackageVersion });
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
    assert.deepEqual(JSON.parse(globalVersion.stdout).data, { version: cliPackageVersion, coreVersion: corePackageVersion });
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
const answers = ['2', '1', '1', '1', 'https://interactive.invalid', 'fixture@example.test', '1', '1', '1', '2'];
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
 else if (url.pathname === '/mcp/settings') value={enabled:true};
 else if (url.pathname === '/mcp/settings/credentials' && init?.method === 'POST') { const body=JSON.parse(init.body); value={id:44,name:body.name,scopes:body.scopes,createdAt:'2026-01-01T00:00:00.000Z',secret:'mcp_live_fixture_secret'}; }
 else throw Error('Unexpected fixture route '+url.pathname);
 return Response.json(value);
};
`);
    const env: NodeJS.ProcessEnv = { ...process.env, NOTCHLET_CONFIG_DIR: config, NOTCHLET_MCP_VERIFY: '0' };
    for (const name of ['NOTCHLET_TOKEN', 'NOTCHLET_EMAIL', 'NOTCHLET_PASSWORD', 'NOTCHLET_SERVER']) delete env[name];
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'init', '--interactive'], { cwd: root, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    assert.equal(workspace.binding.productId, 31);
    assert.equal(workspace.binding.repositoryId, 7);
    assert.equal(workspace.preferences.syncMode, 'manual');
    assert.match(result.stderr, /Organizations:[\s\S]*Products:[\s\S]*Repositories:/);
    assert.match(result.stdout, /https:\/\/interactive\.invalid/);
    assert.match(result.stdout, /Product ID.*31/);
    assert.match(result.stdout, /Repository ID.*7/);
    assert.match(result.stdout, /github\.com\/example\/repo/);
    assert.match(result.stdout, /Agent skills.*OpenCode/);
    assert.match(result.stdout, /MCP access.*configured for OpenCode/);
    assert.match(result.stderr, /documents:write, tickets:write, generation:run, issues:sync/);
    assert.match(result.stderr, /MCP credential scopes:/);
    const opencodeConfig = await readFile(path.join(root, 'opencode.json'), 'utf8');
    assert.match(opencodeConfig, /"type": "local"/);
    assert.match(opencodeConfig, /"serve",\s*"--server",\s*"https:\/\/interactive\.invalid"/);
    const mcpState = await readFile(path.join(root, '.notchlet', '.local', 'mcp.json'), 'utf8');
    assert.match(mcpState, /"credential"/);
    assert.doesNotMatch(opencodeConfig + mcpState + result.stdout + result.stderr, /mcp_live_fixture_secret/);
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

test('init --local --client installs skills and the offline MCP entry without network access', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-local-init-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  try {
    const result = spawnSync(process.execPath, [cli, 'init', '--local', '--client', 'opencode', '--json'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.data.mode, 'local');
    assert.equal(envelope.data.mcp.status, 'configured');
    const config = JSON.parse(await readFile(path.join(dir, 'opencode.json'), 'utf8'));
    assert.deepEqual(config.mcp.notchlet, { type: 'local', command: ['notchlet', 'mcp', 'serve', '--local'] });
    assert.match(await readFile(path.join(dir, '.opencode', 'skills', 'notchlet-super', 'SKILL.md'), 'utf8'), /notchlet-super/);
    const status = spawnSync(process.execPath, [cli, 'mcp', 'status', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout).data;
    assert.equal(report.servers[0].server, 'local');
    assert.equal(report.servers[0].transport, 'local');
    assert.equal(report.servers[0].clients[0].state, 'configured');
    const human = spawnSync(process.execPath, [cli, 'mcp', 'status'], { cwd: dir, encoding: 'utf8' });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Transport: local/);
    assert.match(human.stdout, /OpenCode: configured - opencode\.json/);
    assert.match(human.stdout, /requires no remote credential/);
    assert.doesNotMatch(human.stdout, /Credential|Keyring|Account MCP|none recorded/);
    assert.doesNotMatch(human.stdout, /\x1b\[/);
    const token = spawnSync(process.execPath, [cli, 'mcp', 'token', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(token.status, 0);
    assert.match(JSON.parse(token.stdout).error.message, /local-only|No MCP credential/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('piped human output contains no ANSI escapes and JSON inspection reports the scaffolded revision', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-piped-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const plainEnv = { ...process.env };
  delete plainEnv.NO_COLOR;
  const run = (args: string[], env: NodeJS.ProcessEnv = plainEnv) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8' });
  try {
    assert.equal(run(['init']).status, 0);
    const created = run(['change', 'new', 'Piped Output', '--quick', '--json']);
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).data.id as string;
    const inspected = run(['change', 'show', id, '--json']);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).data.change.revision, 0);

    for (const env of [plainEnv, { ...plainEnv, NO_COLOR: '1' }]) {
      for (const args of [['status'], ['change', 'list'], ['change', 'show', id], ['status', id]]) {
        const result = run(args, env);
        assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
        assert.ok(result.stdout.trim().length > 0);
        assert.doesNotMatch(result.stdout, /\x1b\[/, args.join(' '));
        assert.doesNotMatch(result.stderr, /\x1b\[/, args.join(' '));
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('remote MCP status keeps credential, keyring, and account diagnostics visible', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-remote-status-'));
  const root = path.join(parent, 'checkout');
  const config = path.join(parent, 'config');
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const origin = 'https://remote.example.test';
  const env: NodeJS.ProcessEnv = { ...process.env, NOTCHLET_CONFIG_DIR: config, NOTCHLET_TOKEN: 'remote-status-token' };
  delete env.NO_COLOR;
  try {
    await mkdir(root, { recursive: true });
    assert.equal(spawnSync(process.execPath, [cli, 'init'], { cwd: root, env, encoding: 'utf8' }).status, 0);
    await mkdir(path.join(root, '.notchlet', '.local'), { recursive: true });
    await writeFile(path.join(root, '.notchlet', '.local', 'mcp.json'), JSON.stringify({
      schemaVersion: 1,
      servers: {
        [origin]: {
          credential: { key: 'mcp:key', id: 42, name: 'notchlet-opencode', scopes: ['workspace:read'], createdAt: '2026-01-01T00:00:00.000Z' },
          clients: { opencode: { relativePath: 'opencode.json', serverName: 'notchlet', entryHash: 'unused', configuredAt: '2026-01-01T00:00:00.000Z', transport: 'remote', tokenEnv: 'NOTCHLET_MCP_TOKEN' } },
        },
      },
    }));
    await writeFile(path.join(root, 'opencode.json'), JSON.stringify({
      mcp: { notchlet: { type: 'remote', url: `${origin}/mcp`, headers: { Authorization: 'Bearer {env:NOTCHLET_MCP_TOKEN}' } } },
    }));
    const key = Buffer.from(origin).toString('base64url');
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, 'profiles.json'), JSON.stringify({
      schemaVersion: 1,
      current: key,
      profiles: { [key]: { origin, serverIdentity: origin, credentialStore: 'file', authMode: 'token' } },
    }));

    const status = spawnSync(process.execPath, [cli, 'mcp', 'status'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`Transport: remote`));
    assert.match(status.stdout, /Credential: notchlet-opencode \(id 42\)/);
    assert.match(status.stdout, /Keyring: (missing|present|unavailable)/);
    assert.match(status.stdout, /Account MCP: (unknown|enabled|disabled)/);
    assert.doesNotMatch(status.stdout, /requires no remote credential/);
    assert.doesNotMatch(status.stdout, /\x1b\[/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('task complete --all completes dependent tasks under one revision with end-of-change evidence policy', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-complete-all-cli-'));
  const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run(['init']).status, 0);
    const created = run(['change', 'new', 'Batch completion', '--quick']);
    const id = JSON.parse(created.stdout).data.id as string;
    const statePath = path.join(dir, '.notchlet', 'changes', id, 'tasks.json');
    const change = JSON.parse(await readFile(statePath, 'utf8'));
    Object.assign(change, {
      intent: 'Complete the work', outcome: 'All tasks are complete',
      capabilityImpact: 'none', capabilityRationale: 'Documentation-only maintenance.',
      evidencePolicy: 'end-of-change',
      requirements: [{ id: 'REQ-1', title: 'Requirement', description: 'The behavior remains available.' }],
      tasks: [
        { id: 'TASK-2', title: 'Second', status: 'pending', dependencies: ['TASK-1'], requirementIds: ['REQ-1'] },
        { id: 'TASK-1', title: 'First', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] },
      ],
    });
    await writeFile(statePath, JSON.stringify(change, null, 2));
    const before = change.revision as number;
    const completed = run(['task', 'complete', '--all', '--change', id]);
    assert.equal(completed.status, 0, `${completed.stderr}\n${completed.stdout}`);
    const data = JSON.parse(completed.stdout).data;
    assert.deepEqual(data.tasks.map((task: { id: string; status: string }) => [task.id, task.status]), [['TASK-2', 'completed'], ['TASK-1', 'completed']]);
    assert.equal(data.revision, before + 1);
    assert.equal((JSON.parse(completed.stdout).warnings ?? []).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

