import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWorkspace } from '@notchlet/core';
import { installClientGuidance } from './guidance-install.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('client guidance install/upgrade previews are idempotent and preserve unmanaged or locally modified files', async () => {
  execFileSync(process.execPath, [path.join(packageRoot, 'scripts', 'generate-guidance.mjs')], { cwd: path.resolve(packageRoot, '../..'), stdio: 'pipe' });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'notchlet-client-guidance-'));
  try {
    const root = path.join(temp, 'checkout');
    await mkdir(root);
    await initWorkspace(root);
    const opencodeConfig = path.join(root, '.opencode', 'config.json');
    const claudeSettings = path.join(root, '.claude', 'settings.json');
    await mkdir(path.dirname(opencodeConfig), { recursive: true });
    await mkdir(path.dirname(claudeSettings), { recursive: true });
    await writeFile(opencodeConfig, '{"mcp":{"other":{"url":"https://example.test"}}}\n');
    await writeFile(claudeSettings, '{"permissions":{"allow":[]}}\n');

    for (const client of ['opencode', 'claude'] as const) {
      const preview = await installClientGuidance(root, client);
      assert.equal(preview.action, 'install');
      assert.equal(preview.applied, false);
      assert.equal(preview.results.length, 8);
      assert.equal(preview.results.every(r => r.applied === false), true);
      const applied = await installClientGuidance(root, client, { apply: true });
      assert.equal(applied.action, 'install');
      assert.equal(applied.applied, true);
      assert.equal(applied.results.length, 8);
      assert.equal(applied.results.every(r => r.applied === true), true);
      assert.equal((await installClientGuidance(root, client, { apply: true })).action, 'unchanged');
    }

    const target = path.join(root, '.opencode', 'skills', 'notchlet-super', 'SKILL.md');
    const canonical = await readFile(path.join(packageRoot, 'guidance', 'generated', 'opencode', 'notchlet-super', 'SKILL.md'), 'utf8');
    const oldGenerated = `${canonical}\n<!-- prior generated revision -->\n`;
    const oldHash = hash(oldGenerated);
    await writeFile(target, oldGenerated);
    const manifestPath = path.join(root, '.notchlet', '.local', 'client-guidance.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.clients.opencode['notchlet-super'].installedHash = oldHash;
    manifest.clients.opencode['notchlet-super'].sourceHash = oldHash;
    manifest.clients.opencode['notchlet-super'].sourceVersion = '0.0.9';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const upgraded = await installClientGuidance(root, 'opencode', { apply: true });
    assert.equal(upgraded.action, 'update');
    assert.equal(await readFile(target, 'utf8'), canonical);

    await writeFile(target, `${canonical}\n# Local edit\n`);
    const localEdit = await installClientGuidance(root, 'opencode', { apply: true });
    assert.equal(localEdit.action, 'conflict');
    assert.match(await readFile(target, 'utf8'), /Local edit/);
    assert.equal(await readFile(opencodeConfig, 'utf8'), '{"mcp":{"other":{"url":"https://example.test"}}}\n');
    assert.equal(await readFile(claudeSettings, 'utf8'), '{"permissions":{"allow":[]}}\n');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
