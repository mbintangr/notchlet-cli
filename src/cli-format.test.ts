import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const formatUrl = new URL('./cli-format.js', import.meta.url).href;

function render(tty: boolean, env: NodeJS.ProcessEnv): string[] {
  const script = `
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: ${tty} });
    const m = await import(${JSON.stringify(formatUrl)});
    process.stdout.write(JSON.stringify([m.section('Section'), m.kv('Label', 'value'), m.bullet('item'), m.divider(), m.ok('ok'), m.err('err'), m.warn('warn'), m.table([], []), m.table(['Header'], [['cell']])]));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as string[];
}

function envWithoutColor(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NO_COLOR;
  return env;
}

test('formatters emit no ANSI escapes when stdout is not a TTY', () => {
  const lines = render(false, envWithoutColor());
  for (const line of lines) assert.doesNotMatch(line, /\x1b\[/);
  assert.equal(lines[0], 'Section');
  assert.equal(lines[3], '──────────────────────────────────────────────────────────────');
});

test('formatters emit no ANSI escapes when NO_COLOR is set even on a TTY', () => {
  const lines = render(true, { ...envWithoutColor(), NO_COLOR: '1' });
  for (const line of lines) assert.doesNotMatch(line, /\x1b\[/);
});

test('formatters still colorize when stdout is a TTY and NO_COLOR is unset', () => {
  const lines = render(true, envWithoutColor());
  assert.equal(lines[0], '\x1b[1mSection\x1b[0m');
  assert.equal(lines[1], '  \x1b[2mLabel\x1b[0m: value');
  assert.match(lines[3], /^\x1b\[2m.*\x1b\[0m$/);
});
