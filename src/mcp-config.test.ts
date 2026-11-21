import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeRemoteServerEntry, claudeServerEntry, hashMcpEntry, inspectMcpProjectConfig, mergeMcpProjectConfig, openCodeLocalServerEntry, openCodeRemoteServerEntry, openCodeServerEntry, parseJsonc, removeMcpProjectConfig } from './mcp-config.js';

function runOpenCode(args: string[], options: Parameters<typeof spawnSync>[2] = {}) {
  // Windows resolves the npm `opencode` shim through cmd.exe; the extensionless
  // shell script cannot be spawned directly.
  return process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'opencode', ...args], options)
    : spawnSync('opencode', args, options);
}

function installedOpenCodeVersion(): string | undefined {
  try {
    const result = runOpenCode(['--version'], { encoding: 'utf8', timeout: 20_000 });
    return result.status === 0 ? String(result.stdout).trim() : undefined;
  } catch { return undefined; }
}

const opencodeVersion = installedOpenCodeVersion();

function resolvedOpenCodeConfig(root: string, parent: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(parent, 'xdg'), HOME: path.join(parent, 'home'), USERPROFILE: path.join(parent, 'home') };
  delete env.OPENCODE_CONFIG;
  const result = runOpenCode(['debug', 'config'], { cwd: root, encoding: 'utf8', timeout: 30_000, env });
  assert.equal(result.status, 0, String(result.stderr));
  const start = String(result.stdout).indexOf('{');
  assert.notEqual(start, -1, String(result.stdout));
  return JSON.parse(String(result.stdout).slice(start)) as Record<string, any>;
}

async function tempRoot() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'notchlet-mcp-config-'));
  const root = path.join(parent, 'checkout');
  await mkdir(root, { recursive: true });
  return { parent, root };
}

test('OpenCode config merge creates a secret-free local entry, preserves unrelated settings, and is idempotent', async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['other'] } } }, null, 2)}\n`);

    const preview = await mergeMcpProjectConfig(root, 'opencode', 'https://Example.test');
    assert.equal(preview.relativePath, 'opencode.json');
    assert.equal(preview.action, 'update');
    assert.equal(await readFile(path.join(root, 'opencode.json'), 'utf8'), `${JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['other'] } } }, null, 2)}\n`);

    const applied = await mergeMcpProjectConfig(root, 'opencode', 'https://Example.test', { apply: true });
    assert.equal(applied.action, 'update');
    const value = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(value.theme, 'dark');
    assert.deepEqual(value.mcp.other, { type: 'local', command: ['other'] });
    assert.deepEqual(value.mcp.notchlet, openCodeServerEntry('https://Example.test'));
    assert.equal(JSON.stringify(value).includes('mcp_live_'), false);
    assert.equal(JSON.stringify(value).includes('Authorization'), false);

    const again = await mergeMcpProjectConfig(root, 'opencode', 'https://Example.test', { apply: true, managedEntryHash: applied.entryHash });
    assert.equal(again.action, 'unchanged');

    const inspected = await inspectMcpProjectConfig(root, 'opencode', 'https://Example.test');
    assert.equal(inspected.action, 'unchanged');
    assert.equal(inspected.present, true);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('OpenCode merge updates an entry it previously managed but preserves a user-authored entry', async () => {
  const { parent, root } = await tempRoot();
  try {
    const first = await mergeMcpProjectConfig(root, 'opencode', 'https://old.example.test', { apply: true });
    const second = await mergeMcpProjectConfig(root, 'opencode', 'https://new.example.test', { apply: true, managedEntryHash: first.entryHash });
    assert.equal(second.action, 'update');
    const value = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.deepEqual(value.mcp.notchlet, openCodeServerEntry('https://new.example.test'));

    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ mcp: { notchlet: { type: 'remote', url: 'https://custom' } } }, null, 2)}\n`);
    const before = await readFile(path.join(root, 'opencode.json'), 'utf8');
    const conflict = await mergeMcpProjectConfig(root, 'opencode', 'https://new.example.test', { apply: true, managedEntryHash: second.entryHash });
    assert.equal(conflict.action, 'conflict');
    assert.match(conflict.reason ?? '', /differs from the generated entry/);
    assert.equal(await readFile(path.join(root, 'opencode.json'), 'utf8'), before);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Claude .mcp.json merge uses stdio command/args and preserves other servers', async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, '.mcp.json'), `${JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'other', args: [] } } }, null, 2)}\n`);
    const applied = await mergeMcpProjectConfig(root, 'claude', 'https://claude.example.test', { apply: true });
    assert.equal(applied.action, 'update');
    const value = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(value.mcpServers.existing, { type: 'stdio', command: 'other', args: [] });
    assert.deepEqual(value.mcpServers.notchlet, claudeServerEntry('https://claude.example.test'));
    assert.equal(value.mcpServers.notchlet.command, 'notchlet');
    assert.deepEqual(value.mcpServers.notchlet.args, ['mcp', 'serve', '--server', 'https://claude.example.test']);
    assert.deepEqual(value.mcpServers.notchlet.env, {});
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('JSONC support preserves unrelated values and disambiguates strings from comments', async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, 'opencode.jsonc'), `{
  // a comment with "quotes"
  "theme": "dark // not a comment",
  "mcp": {} /* block comment */
}\n`);
    assert.deepEqual(parseJsonc(await readFile(path.join(root, 'opencode.jsonc'), 'utf8')), { theme: 'dark // not a comment', mcp: {} });
    const applied = await mergeMcpProjectConfig(root, 'opencode', 'https://jsonc.example.test', { apply: true });
    assert.equal(applied.relativePath, 'opencode.jsonc');
    assert.equal(applied.action, 'update');
    const value = JSON.parse(await readFile(path.join(root, 'opencode.jsonc'), 'utf8'));
    assert.equal(value.theme, 'dark // not a comment');
    assert.deepEqual(value.mcp.notchlet, openCodeServerEntry('https://jsonc.example.test'));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('malformed, symlinked, or structurally incompatible configuration is reported as a conflict without mutation', async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, 'opencode.json'), '{ not json');
    const malformed = await mergeMcpProjectConfig(root, 'opencode', 'https://conflict.example.test', { apply: true });
    assert.equal(malformed.action, 'conflict');
    assert.equal(await readFile(path.join(root, 'opencode.json'), 'utf8'), '{ not json');

    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ mcp: [] })}\n`);
    const shape = await mergeMcpProjectConfig(root, 'opencode', 'https://conflict.example.test', { apply: true });
    assert.equal(shape.action, 'conflict');
    assert.match(shape.reason ?? '', /mcp/);

    await rm(path.join(root, 'opencode.json'));
    await writeFile(path.join(root, 'real.json'), `${JSON.stringify({ theme: 'light' })}\n`);
    try {
      await symlink(path.join(root, 'real.json'), path.join(root, 'opencode.json'));
    } catch {
      return; // Symlink creation may require privileges on Windows; the remaining assertions still cover the other cases.
    }
    const linked = await mergeMcpProjectConfig(root, 'opencode', 'https://conflict.example.test', { apply: true });
    assert.equal(linked.action, 'conflict');
    assert.match(linked.reason ?? '', /symbolic link/);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'real.json'), 'utf8')), { theme: 'light' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('removal deletes only the Notchlet key and refuses an unrecognized entry unless explicitly allowed', async () => {
  const { parent, root } = await tempRoot();
  try {
    await mergeMcpProjectConfig(root, 'claude', 'https://remove.example.test', { apply: true });
    const pathFile = path.join(root, '.mcp.json');
    const value = JSON.parse(await readFile(pathFile, 'utf8'));
    value.mcpServers.notchlet = { command: 'custom', args: ['x'] };
    await writeFile(pathFile, `${JSON.stringify(value, null, 2)}\n`);

    const refused = await removeMcpProjectConfig(root, 'claude');
    assert.equal(refused.action, 'conflict');
    assert.ok(JSON.parse(await readFile(pathFile, 'utf8')).mcpServers.notchlet);

    const removed = await removeMcpProjectConfig(root, 'claude', { apply: true, allowModified: true });
    assert.equal(removed.action, 'removed');
    assert.deepEqual(JSON.parse(await readFile(pathFile, 'utf8')).mcpServers, {});

    const missing = await removeMcpProjectConfig(root, 'claude', { apply: true });
    assert.equal(missing.action, 'not-configured');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('entry hashing is canonical across key order and distinguishes different origins', () => {
  assert.equal(hashMcpEntry({ a: 1, b: [2, { c: true, d: null }] }), hashMcpEntry({ b: [2, { d: null, c: true }], a: 1 }));
  assert.notEqual(hashMcpEntry(openCodeServerEntry('https://one.example.test')), hashMcpEntry(openCodeServerEntry('https://two.example.test')));
});

test('OpenCode entries omit enabled/disabled and treat the default enablement fields as equivalent', () => {
  const entry = openCodeServerEntry('https://defaults.example.test');
  assert.deepEqual(entry, { type: 'local', command: ['notchlet', 'mcp', 'serve', '--server', 'https://defaults.example.test'] });
  assert.equal('enabled' in entry, false);
  assert.equal('disabled' in entry, false);
  assert.equal(hashMcpEntry({ ...entry, enabled: true }), hashMcpEntry(entry));
  assert.equal(hashMcpEntry({ ...entry, disabled: false }), hashMcpEntry(entry));
  assert.notEqual(hashMcpEntry({ ...entry, enabled: false }), hashMcpEntry(entry));
  assert.notEqual(hashMcpEntry({ ...entry, disabled: true }), hashMcpEntry(entry));
});

test('V2 mcp.servers configuration is preserved and updated in place without adding a flat duplicate', async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({
      theme: 'dark',
      mcp: {
        timeout: { startup: 45000 },
        servers: { other: { type: 'local', command: ['other'] } },
      },
    }, null, 2)}\n`);

    const applied = await mergeMcpProjectConfig(root, 'opencode', 'https://v2.example.test', { apply: true });
    assert.equal(applied.action, 'update');
    assert.equal(applied.relativePath, 'opencode.json');
    const value = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(value.theme, 'dark');
    assert.deepEqual(value.mcp.timeout, { startup: 45000 });
    assert.deepEqual(value.mcp.servers.other, { type: 'local', command: ['other'] });
    assert.deepEqual(value.mcp.servers.notchlet, openCodeServerEntry('https://v2.example.test'));
    assert.equal('enabled' in value.mcp.servers.notchlet, false);
    assert.equal(value.mcp.notchlet, undefined);

    const again = await mergeMcpProjectConfig(root, 'opencode', 'https://v2.example.test', { apply: true });
    assert.equal(again.action, 'unchanged');
    const inspected = await inspectMcpProjectConfig(root, 'opencode', 'https://v2.example.test');
    assert.equal(inspected.action, 'unchanged');
    assert.equal(inspected.present, true);

    const replaced = await mergeMcpProjectConfig(root, 'opencode', 'https://new-v2.example.test', { apply: true, managedEntryHash: applied.entryHash });
    assert.equal(replaced.action, 'update');
    const updated = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.deepEqual(updated.mcp.servers.notchlet, openCodeServerEntry('https://new-v2.example.test'));
    assert.deepEqual(updated.mcp.servers.other, { type: 'local', command: ['other'] });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('a V2 config with a user-authored notchlet entry is preserved as a conflict', async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ mcp: { servers: { notchlet: { type: 'remote', url: 'https://custom' } } } }, null, 2)}\n`);
    const before = await readFile(path.join(root, 'opencode.json'), 'utf8');
    const preview = await mergeMcpProjectConfig(root, 'opencode', 'https://v2.example.test', { apply: true });
    assert.equal(preview.action, 'conflict');
    assert.match(preview.reason ?? '', /differs from the generated entry/);
    assert.equal(await readFile(path.join(root, 'opencode.json'), 'utf8'), before);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('a legacy flat entry that shadows mcp.servers.notchlet is reported instead of silently overridden', async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ mcp: { notchlet: { type: 'local', command: ['legacy'] }, servers: {} } }, null, 2)}\n`);
    const before = await readFile(path.join(root, 'opencode.json'), 'utf8');
    const preview = await mergeMcpProjectConfig(root, 'opencode', 'https://v2.example.test', { apply: true });
    assert.equal(preview.action, 'conflict');
    assert.match(preview.reason ?? '', /overrides "mcp\.servers\.notchlet"/);
    assert.equal(await readFile(path.join(root, 'opencode.json'), 'utf8'), before);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('an entry generated before the enabled-field change is recognized as already configured', async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ mcp: { notchlet: { ...openCodeServerEntry('https://legacy.example.test'), enabled: true } } }, null, 2)}\n`);
    const preview = await mergeMcpProjectConfig(root, 'opencode', 'https://legacy.example.test');
    assert.equal(preview.action, 'unchanged');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('removal handles both the flat and V2 shapes without touching sibling servers', async () => {
  const { parent, root } = await tempRoot();
  try {
    await mergeMcpProjectConfig(root, 'opencode', 'https://flat.example.test', { apply: true });
    const flatRemoved = await removeMcpProjectConfig(root, 'opencode', { apply: true });
    assert.equal(flatRemoved.action, 'removed');
    const flatValue = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(flatValue.mcp.notchlet, undefined);

    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ mcp: { servers: { notchlet: openCodeServerEntry('https://v2.example.test'), other: { type: 'local', command: ['other'] } } } }, null, 2)}\n`);
    const v2Removed = await removeMcpProjectConfig(root, 'opencode', { apply: true });
    assert.equal(v2Removed.action, 'removed');
    const v2Value = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(v2Value.mcp.servers.notchlet, undefined);
    assert.deepEqual(v2Value.mcp.servers.other, { type: 'local', command: ['other'] });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('generated OpenCode configuration is read by the installed OpenCode client', { skip: opencodeVersion ? false : 'opencode CLI not installed' }, async () => {
  const { parent, root } = await tempRoot();
  try {
    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);
    await mergeMcpProjectConfig(root, 'opencode', 'https://flat-client.example.test', { apply: true });
    const flatResolved = resolvedOpenCodeConfig(root, parent);
    assert.equal(flatResolved.mcp.notchlet.type, 'local');
    assert.deepEqual(flatResolved.mcp.notchlet.command, ['notchlet', 'mcp', 'serve', '--server', 'https://flat-client.example.test']);

    await writeFile(path.join(root, 'opencode.json'), `${JSON.stringify({ mcp: { servers: { other: { type: 'local', command: ['other'] } } } }, null, 2)}\n`);
    await mergeMcpProjectConfig(root, 'opencode', 'https://v2-client.example.test', { apply: true });
    const v2Resolved = resolvedOpenCodeConfig(root, parent);
    assert.equal(v2Resolved.mcp.notchlet.type, 'local');
    assert.deepEqual(v2Resolved.mcp.notchlet.command, ['notchlet', 'mcp', 'serve', '--server', 'https://v2-client.example.test']);
    const written = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(written.mcp.servers.notchlet.enabled, undefined);
    assert.equal(written.mcp.servers.notchlet.disabled, undefined);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('remote MCP entries use the documented OpenCode shape and an environment token reference', async () => {
  const { parent, root } = await tempRoot();
  try {
    const preview = await mergeMcpProjectConfig(root, 'opencode', 'https://remote.example.test', { transport: 'remote', apply: true });
    assert.equal(preview.action, 'create');
    const value = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.deepEqual(value.mcp.notchlet, openCodeRemoteServerEntry('https://remote.example.test'));
    assert.equal(value.mcp.notchlet.type, 'remote');
    assert.equal(value.mcp.notchlet.url, 'https://remote.example.test/mcp');
    assert.equal(value.mcp.notchlet.headers.Authorization, 'Bearer {env:NOTCHLET_MCP_TOKEN}');
    assert.doesNotMatch(JSON.stringify(value), /eyJ[A-Za-z0-9_-]+/);

    const custom = await mergeMcpProjectConfig(root, 'opencode', 'https://remote.example.test', { transport: 'remote', tokenEnv: 'ACME_MCP_TOKEN' });
    assert.equal(custom.action, 'conflict');
    const updated = await mergeMcpProjectConfig(root, 'opencode', 'https://remote.example.test', { transport: 'remote', tokenEnv: 'ACME_MCP_TOKEN', managedEntryHash: preview.entryHash, apply: true });
    assert.equal(updated.action, 'update');
    const customValue = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.equal(customValue.mcp.notchlet.headers.Authorization, 'Bearer {env:ACME_MCP_TOKEN}');

    const inspected = await inspectMcpProjectConfig(root, 'opencode', 'https://remote.example.test', { transport: 'remote', tokenEnv: 'ACME_MCP_TOKEN' });
    assert.equal(inspected.present, true);
    assert.equal(inspected.action, 'unchanged');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('Claude remote entries use streamable HTTP and local entries need no account', async () => {
  const { parent, root } = await tempRoot();
  try {
    await mergeMcpProjectConfig(root, 'claude', 'https://claude-remote.example.test', { transport: 'remote', apply: true });
    const claude = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(claude.mcpServers.notchlet, claudeRemoteServerEntry('https://claude-remote.example.test'));
    assert.equal(claude.mcpServers.notchlet.type, 'http');

    await mergeMcpProjectConfig(root, 'opencode', 'local', { transport: 'local', apply: true });
    const opencode = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    assert.deepEqual(opencode.mcp.notchlet, openCodeLocalServerEntry());
    assert.deepEqual(opencode.mcp.notchlet.command, ['notchlet', 'mcp', 'serve', '--local']);

    const removed = await removeMcpProjectConfig(root, 'opencode', { apply: true });
    assert.equal(removed.action, 'removed');
    assert.equal(JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8')).mcp.notchlet, undefined);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
