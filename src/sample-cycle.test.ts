import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cli = process.env.NOTCHLET_PACKED_CLI_PATH ?? path.resolve('dist/cli.js');

function argv(line: string): string[] {
  return (line.match(/"[^"]*"|\S+/g) ?? []).map(token => token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token);
}

test('generated guidance documents the cycle and its sample block runs a clean workspace to local closure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notchlet-sample-cycle-'));
  try {
    const init = spawnSync(process.execPath, [cli, 'init', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const agents = await readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    const readme = await readFile(path.join(dir, '.notchlet', 'README.md'), 'utf8');
    const prompt = await readFile(path.join(dir, 'PROMPT.md'), 'utf8');
    for (const pattern of [/workspace bind --create/, /backlog set/, /verify <change> --record/, /evidence list --change/, /sync deliver --change <change> --status DONE/, /status_divergent/, /## Sample cycle/]) assert.match(agents, pattern);
    for (const pattern of [/workspace bind --create/, /backlog set/, /evidence list --change/, /sync deliver --change <change> --status DONE/, /Sample cycle/]) assert.match(readme, pattern);
    for (const pattern of [/workspace bind --create/, /backlog set/, /sync status --change/, /sync deliver --change/]) assert.match(prompt, pattern);
    assert.doesNotMatch(agents, /[A-Za-z]:\\\\|\/Users\/|\/home\//, 'guidance must not contain machine-specific absolute paths');

    const block = /<!-- notchlet:sample-cycle -->\s*```bash\n([\s\S]*?)```/.exec(agents);
    assert.ok(block, 'sample cycle fenced block must be present');
    const commands = block![1].split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    assert.ok(commands.length >= 10, 'sample cycle must cover planning, verification, evidence, and closure');
    assert.equal(commands[0], 'notchlet init');
    for (const line of commands) {
      const [bin, ...args] = argv(line);
      assert.equal(bin, 'notchlet', `sample line must invoke notchlet: ${line}`);
      const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, `${line}\n${result.stdout}\n${result.stderr}`);
    }
    await readFile(path.join(dir, '.notchlet', 'archive', 'sample-cycle', 'closure.json'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
