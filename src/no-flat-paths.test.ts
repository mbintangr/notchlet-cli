import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cliRoot = path.resolve(import.meta.dirname, '..');
const coreSrc = path.resolve(cliRoot, '..', 'notchlet-core', 'src');
const FLAT_CHANGE_DIR = /(?<!\.)['"]changes['"]\s*,\s*(?:change\.id|result\.changeId)\b/;

test('change directories resolve through relative paths instead of flat ids', async () => {
  const files = [
    ...['index.ts', 'closure.ts', 'evidence.ts', 'tree.ts', 'backlog.ts'].map(file => path.join(coreSrc, file)),
    ...['verify.ts', 'history.ts', 'mcp-local.ts', 'backlog-sync.ts', 'migrate.ts', 'tree-format.ts'].map(file => path.join(cliRoot, 'src', file)),
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, FLAT_CHANGE_DIR, `${path.relative(cliRoot, file)} builds a change directory from a flat id`);
  }
});
