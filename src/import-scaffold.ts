import type { Change } from '@notchlet/core';

export interface ImportScaffoldInput {
  itemId: number;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
}

export interface ImportScaffold {
  requirements: Change['requirements'];
  checks: Change['checks'];
  tasks: Change['tasks'];
}

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;

function normalizeHeading(raw: string): string {
  return raw.replace(/[*_`]/g, '').replace(/[:#\s]+$/, '').trim().toLowerCase();
}

/** Bullets under the first Markdown heading matching `heading`, stopping at the next heading. */
export function markdownSectionBullets(markdown: string, heading: RegExp): string[] {
  const bullets: string[] = [];
  let active = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const headingMatch = HEADING.exec(line);
    if (headingMatch) {
      if (active) break;
      active = heading.test(normalizeHeading(headingMatch[2]));
      continue;
    }
    if (!active) continue;
    const bulletMatch = BULLET.exec(line);
    if (bulletMatch) bullets.push(bulletMatch[1].trim());
  }
  return bullets;
}

/**
 * Derives importable requirements, checks, and tasks from a backlog description:
 * one requirement per acceptance-criteria bullet (structured criteria as fallback),
 * one linked check per requirement, and one task per scope bullet. IDs are positional.
 */
export function deriveImportScaffold(input: ImportScaffoldInput): ImportScaffold {
  const markdownCriteria = markdownSectionBullets(input.description, /^acceptance criteria\b/);
  const structured = (input.acceptanceCriteria ?? []).map(value => value.trim()).filter(Boolean);
  const criteria = markdownCriteria.length ? markdownCriteria : structured;
  const requirements: Change['requirements'] = criteria.length
    ? criteria.map((text, index) => ({ id: `REQ-${index + 1}`, title: text, description: text }))
    : [{ id: 'REQ-1', title: input.title, description: input.description.trim() || input.title }];
  const requirementIds = requirements.map(requirement => requirement.id);
  const checks: Change['checks'] = requirements.map((requirement, index) => ({ id: `CHECK-${index + 1}`, description: requirement.title, requirementIds: [requirement.id] }));
  const scope = markdownSectionBullets(input.description, /^scope\b/);
  const tasks: Change['tasks'] = (scope.length ? scope : [`Implement backlog item ${input.itemId}`]).map((title, index) => ({ id: `TASK-${index + 1}`, title, status: 'pending', dependencies: [], requirementIds }));
  return { requirements, checks, tasks };
}
