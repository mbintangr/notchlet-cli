import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files?: string[] };
const listed = new Set((pkg.files ?? []).filter(entry => entry.startsWith('dist/')));

test('the published files list covers every runtime module in dist', () => {
  const runtime = readdirSync(distDir).filter(name => name.endsWith('.js') && !name.endsWith('.test.js')).map(name => `dist/${name}`);
  const unlisted = runtime.filter(name => !listed.has(name));
  assert.deepEqual(unlisted, [], 'every non-test dist module must appear in package.json files, or npm pack will omit it');
  for (const entry of listed) assert.ok(existsSync(new URL(`./${entry.slice('dist/'.length)}`, import.meta.url)), `${entry} is listed in package.json files but missing from dist`);
});

test('listed modules only import other listed modules', () => {
  for (const entry of listed) {
    const source = readFileSync(new URL(`./${entry.slice('dist/'.length)}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+\.js)'/g)) {
      const target = `dist/${match[1].slice(2)}`;
      assert.ok(listed.has(target), `${entry} imports ${match[1]}, but ${target} is missing from package.json files`);
    }
  }
});
