import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

async function closedAuthTree(dir: string): Promise<void> {
  assert.equal(run(dir, ['init']).status, 0);
  assert.equal(run(dir, ['change', 'new', 'Auth', '--as', 'epic']).status, 0);
  assert.equal(run(dir, ['change', 'new', 'Login', '--as', 'story', '--parent', 'auth']).status, 0);
  const leaf = 'auth/login';
  assert.equal(run(dir, ['change', 'add', leaf, 'requirement', '--id', 'R1', '--title', 'Login works', '--description', 'Login form submits.']).status, 0);
  assert.equal(run(dir, ['change', 'add', leaf, 'check', '--id', 'C1', '--description', 'Node exits zero', '--kind', 'command', '--command', 'node -e "process.exit(0)"', '--requirement', 'R1']).status, 0);
  assert.equal(run(dir, ['change', 'add', leaf, 'task', '--id', 'T1', '--title', 'Implement login', '--requirement', 'R1']).status, 0);
  assert.equal(run(dir, ['change', 'update', leaf, '--intent', 'Let a user log in.', '--outcome', 'The login form submits successfully.']).status, 0);
  assert.equal(run(dir, ['task', 'start', 'T1', '--change', leaf]).status, 0);
  assert.equal(run(dir, ['task', 'complete', 'T1', '--change', leaf]).status, 0);
  assert.equal(run(dir, ['change', 'render', leaf, '--write']).status, 0);
  const verified = run(dir, ['verify', leaf, '--record']);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(run(dir, ['change', 'close', leaf]).status, 0);
  const closed = run(dir, ['change', 'close', 'auth', '--json']);
  assert.equal(closed.status, 0, `${closed.stdout}\n${closed.stderr}`);
}

test('closure verify hashes archived child manifests and feeds status, validate, show, and export', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-cli-closure-integrity-'));
  try {
    await closedAuthTree(dir);
    const childClosure = path.join(dir, '.notchlet', 'archive', 'auth', 'login', 'closure.json');
    const parentClosure = path.join(dir, '.notchlet', 'archive', 'auth', 'closure.json');
    const originalChild = await readFile(childClosure, 'utf8');
    const parentManifest = JSON.parse(await readFile(parentClosure, 'utf8')) as { rollup: { children: Array<{ relativePath: string; closureSha256: string }> } };
    const recorded = parentManifest.rollup.children.find(record => record.relativePath === 'auth/login')!;

    const healthy = run(dir, ['closure', 'verify', 'auth', '--tree', '--json']);
    assert.equal(healthy.status, 0, healthy.stdout);
    const healthyData = JSON.parse(healthy.stdout).data;
    assert.equal(healthyData.valid, true);
    assert.equal(healthyData.reports.length, 2);
    assert.equal(healthyData.reports.find((report: any) => report.relativePath === 'auth').checkedChildren, 1);

    await writeFile(childClosure, `${originalChild}\n`);
    const tampered = run(dir, ['closure', 'verify', 'auth', '--tree', '--json']);
    assert.equal(tampered.status, 1);
    const tamperedData = JSON.parse(tampered.stdout);
    assert.equal(tamperedData.ok, false);
    assert.equal(tamperedData.error.code, 'closure_integrity_failed');
    const mismatch = tamperedData.data.issues.find((issue: any) => issue.code === 'child_closure_hash_mismatch');
    assert.ok(mismatch);
    assert.equal(mismatch.recordedSha256, recorded.closureSha256);
    assert.equal(mismatch.actualSha256, createHash('sha256').update(`${originalChild}\n`).digest('hex'));

    const status = run(dir, ['status', 'auth', '--json']);
    assert.equal(status.status, 0, status.stdout);
    const statusData = JSON.parse(status.stdout).data;
    assert.equal(statusData.closureIntegrity.valid, false);
    assert.equal(statusData.facets.closure.ready, false);
    assert.ok(statusData.facets.closure.blockers.some((blocker: any) => blocker.code === 'child_closure_hash_mismatch'));

    const treeStatus = run(dir, ['status', 'auth', '--tree', '--json']);
    assert.equal(treeStatus.status, 0, treeStatus.stdout);
    assert.ok(JSON.parse(treeStatus.stdout).data.tree.warnings.some((warning: any) => warning.code === 'child_closure_hash_mismatch'));

    const validated = run(dir, ['validate', 'auth', '--json']);
    assert.equal(validated.status, 1, validated.stdout);
    const validatedData = JSON.parse(validated.stdout).data;
    assert.equal(validatedData.readiness.ready, false);
    assert.ok(validatedData.readiness.blockers.some((blocker: any) => blocker.code === 'child_closure_hash_mismatch'));
    assert.equal(validatedData.closureIntegrity.valid, false);

    const shown = run(dir, ['change', 'show', 'auth', '--json']);
    assert.equal(shown.status, 0, shown.stdout);
    assert.equal(JSON.parse(shown.stdout).data.closureIntegrity.valid, false);

    const exported = run(dir, ['change', 'export', 'auth', '--format', 'json', '--json']);
    assert.equal(exported.status, 0, exported.stdout);
    assert.equal(JSON.parse(exported.stdout).data.closureIntegrity.valid, false);

    const tree = run(dir, ['change', 'tree', '--json']);
    assert.equal(tree.status, 0, tree.stdout);
    assert.ok(JSON.parse(tree.stdout).data.tree.warnings.some((warning: any) => warning.code === 'child_closure_hash_mismatch'));

    const restoreChild = run(dir, ['change', 'restore', 'auth/login', '--json']);
    assert.equal(restoreChild.status, 1);
    assert.equal(JSON.parse(restoreChild.stdout).error.code, 'parent_restore_required');
    assert.equal(run(dir, ['change', 'restore', 'auth', '--json']).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
