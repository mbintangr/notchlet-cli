import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveImportScaffold, markdownSectionBullets } from './import-scaffold.js';

const description = `Packed CLI acceptance.

## Acceptance criteria

- Preserve the selected description.
* Record the import marker.
1. Reuse positional IDs.

### Notes
- Not part of the section.

## Scope

- Export the packed fixture.
- Verify the imported change.
`;

test('markdownSectionBullets reads bullets under the matching heading only', () => {
  assert.deepEqual(markdownSectionBullets(description, /^acceptance criteria\b/), [
    'Preserve the selected description.',
    'Record the import marker.',
    'Reuse positional IDs.',
  ]);
  assert.deepEqual(markdownSectionBullets(description, /^scope\b/), [
    'Export the packed fixture.',
    'Verify the imported change.',
  ]);
  assert.deepEqual(markdownSectionBullets('# Title\n\n- Outside any section.\n', /^scope\b/), []);
});

test('deriveImportScaffold derives linked requirements, checks, and tasks from Markdown sections', () => {
  const scaffold = deriveImportScaffold({ itemId: 42, title: 'Packed fixture', description, acceptanceCriteria: ['Structured fallback wins only without Markdown criteria.'] });
  assert.deepEqual(scaffold.requirements.map(requirement => requirement.id), ['REQ-1', 'REQ-2', 'REQ-3']);
  assert.equal(scaffold.requirements[0].title, 'Preserve the selected description.');
  assert.deepEqual(scaffold.checks.map(check => [check.id, check.requirementIds]), [['CHECK-1', ['REQ-1']], ['CHECK-2', ['REQ-2']], ['CHECK-3', ['REQ-3']]]);
  assert.equal(scaffold.checks[0].description, 'Preserve the selected description.');
  assert.deepEqual(scaffold.tasks.map(task => [task.id, task.title]), [['TASK-1', 'Export the packed fixture.'], ['TASK-2', 'Verify the imported change.']]);
  assert.deepEqual(scaffold.tasks[0].requirementIds, ['REQ-1', 'REQ-2', 'REQ-3']);
  assert.deepEqual(scaffold.tasks[0].dependencies, []);
  assert.equal(scaffold.tasks[0].status, 'pending');
  assert.doesNotMatch(JSON.stringify(scaffold), /ITEM/);
});

test('deriveImportScaffold falls back to structured criteria and then to a single derived item', () => {
  const structured = deriveImportScaffold({ itemId: 7, title: 'Structured item', description: 'Plain description.', acceptanceCriteria: ['First criterion.', ' ', 'Second criterion.'] });
  assert.deepEqual(structured.requirements.map(requirement => requirement.title), ['First criterion.', 'Second criterion.']);
  assert.deepEqual(structured.checks.map(check => check.requirementIds), [['REQ-1'], ['REQ-2']]);
  assert.deepEqual(structured.tasks.map(task => [task.id, task.title]), [['TASK-1', 'Implement backlog item 7']]);
  assert.deepEqual(structured.tasks[0].requirementIds, ['REQ-1', 'REQ-2']);

  const bare = deriveImportScaffold({ itemId: 8, title: 'Bare item', description: '' });
  assert.deepEqual(bare.requirements, [{ id: 'REQ-1', title: 'Bare item', description: 'Bare item' }]);
  assert.deepEqual(bare.checks.map(check => [check.id, check.requirementIds]), [['CHECK-1', ['REQ-1']]]);
  assert.deepEqual(bare.tasks.map(task => [task.id, task.title]), [['TASK-1', 'Implement backlog item 8']]);
});
