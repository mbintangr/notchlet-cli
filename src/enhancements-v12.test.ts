import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

const ROADMAP = {
  schemaVersion: 1,
  tree: {
    itemType: 'epic', title: 'Delivery', children: [
      { itemType: 'story', title: 'Checkout', children: [{ itemType: 'task', title: 'Receipt' }] },
    ],
  },
};

test('tree plan dry-run previews create/reuse/conflict and import reruns idempotently', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-tree-cli-v12-'));
  try {
    await initWorkspace(dir);
    await mkdir(path.join(dir, '.notchlet', 'plans'), { recursive: true });
    await writeFile(path.join(dir, '.notchlet', 'plans', 'roadmap.json'), JSON.stringify(ROADMAP, null, 2));

    const preview = run(dir, ['change', 'new', '--from', 'roadmap.json', '--dry-run']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(preview.envelope.data.dryRun, true);
    assert.deepEqual(preview.envelope.data.tree.nodes.map((node: any) => [node.relativePath, node.status]), [
      ['delivery', 'create'],
      ['delivery/checkout', 'create'],
      ['delivery/checkout/receipt', 'create'],
    ]);

    const imported = run(dir, ['change', 'new', '--from', 'roadmap.json']);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.envelope.data.tree.root, 'delivery');
    assert.deepEqual(imported.envelope.data.tree.nodes.map((node: any) => node.status), ['created', 'created', 'created']);
    for (const relative of ['delivery', 'delivery/checkout', 'delivery/checkout/receipt']) {
      await access(path.join(dir, '.notchlet', 'changes', ...relative.split('/'), 'tasks.json'));
    }
    const leaf = JSON.parse(await readFile(path.join(dir, '.notchlet', 'changes', 'delivery', 'checkout', 'receipt', 'tasks.json'), 'utf8'));
    assert.equal(leaf.id, 'receipt');

    const rerun = run(dir, ['change', 'new', '--from', 'roadmap.json']);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.deepEqual(rerun.envelope.data.tree.nodes.map((node: any) => node.status), ['reused', 'reused', 'reused']);

    const planStatus = run(dir, ['change', 'plan', 'status', 'delivery']);
    assert.equal(planStatus.status, 0, planStatus.stderr);
    assert.equal(planStatus.envelope.data.plan.drift.status, 'none');
    assert.equal(planStatus.envelope.data.plan.validation.status, 'ok', 'tree plan provenance validates for imported nodes');

    const conflict = {
      schemaVersion: 1,
      tree: {
        itemType: 'epic', title: 'Delivery', children: [
          { itemType: 'story', title: 'Checkout renamed', slug: 'checkout' },
          { itemType: 'story', title: 'Other story' },
        ],
      },
    };
    await writeFile(path.join(dir, '.notchlet', 'plans', 'conflict.json'), JSON.stringify(conflict, null, 2));
    const previewConflict = run(dir, ['change', 'new', '--from', 'conflict.json', '--dry-run']);
    assert.equal(previewConflict.status, 0, previewConflict.stderr);
    assert.deepEqual(previewConflict.envelope.data.tree.nodes.map((node: any) => node.status), ['reuse', 'conflict', 'create']);

    const rejected = run(dir, ['change', 'new', '--from', 'conflict.json']);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.envelope.error.code, 'plan_path_conflict');
    await assert.rejects(access(path.join(dir, '.notchlet', 'changes', 'delivery', 'other-story')), 'failed import writes nothing');

    const tree = run(dir, ['change', 'tree', 'delivery']);
    assert.equal(tree.status, 0, tree.stderr);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('expected-absent-selector authoring feeds close advisories and task links clear them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-absent-cli-v12-'));
  try {
    await initWorkspace(dir);
    const created = run(dir, ['change', 'new', 'A11y probe', '--quick']);
    assert.equal(created.status, 0, created.stderr);
    const id = created.envelope.data.id as string;

    const task = run(dir, ['change', 'add', id, 'task', '--id', 'TASK-1', '--title', 'Dialog work']);
    assert.equal(task.status, 0, task.stderr);
    const check = run(dir, ['change', 'add', id, 'check',
      '--id', 'CHECK-1',
      '--description', 'Dialog stays hidden while the page renders',
      '--kind', 'ui',
      '--url', 'http://127.0.0.1:9/',
      '--expected-hidden-selector', '#dialog',
      '--expected-absent-selector', '#error-banner',
      '--no-prompt',
    ]);
    assert.equal(check.status, 0, check.stderr);
    const shown = run(dir, ['change', 'show', id]);
    assert.equal(shown.status, 0, shown.stderr);
    const shownCheck = shown.envelope.data.change.checks.find((item: any) => item.id === 'CHECK-1');
    assert.deepEqual(shownCheck.expectedAbsentSelectors, ['#error-banner']);
    assert.deepEqual(shownCheck.expectedHiddenSelectors, ['#dialog']);

    const preview = runHuman(dir, ['change', 'close', id, '--preview']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /no task link/i);
    assert.match(preview.stdout, /only check asserts hidden or absent elements/i);

    const linked = run(dir, ['change', 'update', id, 'check', 'CHECK-1', '--task', 'TASK-1']);
    assert.equal(linked.status, 0, linked.stderr);
    const relinked = runHuman(dir, ['change', 'close', id, '--preview']);
    assert.equal(relinked.status, 0, relinked.stderr);
    assert.doesNotMatch(relinked.stdout, /no task link/i);
    assert.match(relinked.stdout, /only check asserts hidden or absent elements/i, 'linking tasks does not make a negative-only check positive');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('change help documents tree plan import, absent selectors, task links, and rollup closure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-help-v12-'));
  try {
    await initWorkspace(dir);
    const help = runHuman(dir, ['change', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--from <plan\.json\|tree\.json>/);
    assert.match(help.stdout, /--expected-absent-selector/);
    assert.match(help.stdout, /--no-prompt/);

    const newHelp = runHuman(dir, ['change', 'new', '--help']);
    assert.equal(newHelp.status, 0, newHelp.stderr);
    assert.match(newHelp.stdout, /tree/i);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
