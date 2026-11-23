import { spawnSync } from 'node:child_process';
import { buildNode, flattenTree, scanChangeDirectories, WorkflowError, type ChangeTreeNode } from '@notchlet/core';

export interface TreeFailureAssertion {
  kind: string;
  path?: string;
  expected: string;
  observed: string;
}

export interface TreeFailedCheck {
  id: string;
  kind: string;
  detail?: string;
  assertions: TreeFailureAssertion[];
}

export interface TreeVerificationEntry {
  relativePath: string;
  id: string;
  outcome: 'passed' | 'failed' | 'skipped';
  passed: number;
  failed: number;
  skipped: number;
  evidenceId?: string;
  observationBasis?: string;
  advisories?: string[];
  artifactDrift?: boolean;
  renderRecovery?: string;
  executionDrift?: string;
  failurePhase?: 'setup' | 'readiness' | 'checks' | 'repeat';
  failedChecks?: TreeFailedCheck[];
  logPath?: string;
  recovery?: string;
  error?: string;
  reason?: string;
}

export interface TreeVerificationReport {
  outcome: 'passed' | 'failed';
  targets: number;
  openNodes: number;
  archivedNodes: number;
  restoreTarget?: string;
  passed: number;
  failed: number;
  skippedCount: number;
  order: string[];
  observationBasis: 'git' | 'artifact' | 'mixed' | 'none';
  nodes: TreeVerificationEntry[];
  skippedNodes: TreeVerificationEntry[];
}

const runnableKinds = new Set(['command', 'http', 'ui', 'browser']);

function hasRunnableCheck(node: ChangeTreeNode): boolean {
  return node.change.checks.some(check => runnableKinds.has(check.kind ?? 'command'));
}

function depthOf(relativePath: string): number {
  return relativePath.split('/').length;
}

function parseChildEnvelope(stdout: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(stdout);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function childError(child: ReturnType<typeof spawnSync>): string | undefined {
  if (child.error) return child.error.message;
  const stderr = typeof child.stderr === 'string' ? child.stderr.trim() : '';
  return stderr ? stderr.split(/\r?\n/).slice(-3).join(' | ') : undefined;
}

function advisoryMessages(advisories: unknown): string[] {
  if (advisories === null || typeof advisories !== 'object' || Array.isArray(advisories)) return [];
  const messages: string[] = [];
  for (const [group, value] of Object.entries(advisories as Record<string, unknown>)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item === 'string') messages.push(`${group}: ${item}`);
      else if (item !== null && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const text = typeof record.message === 'string' ? record.message : typeof record.reason === 'string' ? record.reason : JSON.stringify(item);
        messages.push(`${group}: ${text}`);
      }
    }
  }
  return messages;
}

function failedCheckDetails(verification: Record<string, any> | undefined): TreeFailedCheck[] {
  const results = Array.isArray(verification?.results) ? verification.results : [];
  return results.flatMap((check: Record<string, any>) => {
    if (check?.status !== 'failed') return [];
    const assertions = (Array.isArray(check.assertions) ? check.assertions : [])
      .filter((assertion: Record<string, any>) => assertion?.passed === false)
      .map((assertion: Record<string, any>) => ({
        kind: String(assertion.kind ?? 'assertion'),
        ...(typeof assertion.path === 'string' ? { path: assertion.path } : {}),
        expected: String(assertion.expected ?? ''),
        observed: String(assertion.observed ?? ''),
      }));
    const kind = typeof check.declaredKind === 'string' ? check.declaredKind : typeof check.kind === 'string' ? check.kind : 'check';
    const detail = check.kind === 'command'
      ? `exit ${check.exitCode ?? 'none'}${check.timedOut === true ? ', timed out' : ''}`
      : (check.kind === 'http' || check.kind === 'ui') && check.observedStatus !== undefined
        ? `HTTP ${check.observedStatus}`
        : undefined;
    return [{ id: String(check.id ?? 'unknown'), kind, ...(detail === undefined ? {} : { detail }), assertions }];
  });
}

function workspaceEvidencePath(relativePath: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const segments = value.split(/[\\/]+/).filter(Boolean);
  return ['.notchlet', 'changes', ...relativePath.split('/'), ...segments].join('/');
}

function failurePhase(value: unknown): TreeVerificationEntry['failurePhase'] {
  return value === 'setup' || value === 'readiness' || value === 'checks' || value === 'repeat' ? value : undefined;
}

/** Restoring a child is refused while an ancestor is archived, so recovery must name the outermost archived node. */
async function topArchivedAncestor(root: string, relativePath: string): Promise<string> {
  const [activeEntries, archivedEntries] = await Promise.all([
    scanChangeDirectories(root, { scope: 'active' }),
    scanChangeDirectories(root, { scope: 'archive' }),
  ]);
  const active = new Set(activeEntries.map(entry => entry.relativePath));
  const archived = new Set(archivedEntries.map(entry => entry.relativePath));
  const segments = relativePath.split('/');
  const archivedAncestors = segments.slice(0, -1)
    .map((_, index) => segments.slice(0, index + 1).join('/'))
    .filter(ancestor => archived.has(ancestor) && !active.has(ancestor));
  return archivedAncestors[0] ?? relativePath;
}

export async function verifyTree(options: {
  root: string;
  reference: string;
  passthrough: string[];
}): Promise<TreeVerificationReport> {
  const entry = process.argv[1];
  if (!entry) throw new WorkflowError('verify_tree_entry_missing', 'Cannot locate the Notchlet CLI entry point for tree verification.', 'Run `notchlet verify <change> --tree` from the installed CLI.');
  const subtree = await buildNode(options.root, options.reference);
  const ordered = flattenTree(subtree).sort((left, right) => depthOf(right.relativePath) - depthOf(left.relativePath) || left.relativePath.localeCompare(right.relativePath));
  const skippedNodes: TreeVerificationEntry[] = [];
  const targets: ChangeTreeNode[] = [];
  let openNodes = 0;
  let archivedNodes = 0;
  for (const node of ordered) {
    if (node.closed) {
      archivedNodes += 1;
      skippedNodes.push({ relativePath: node.relativePath, id: node.id, outcome: 'skipped', passed: 0, failed: 0, skipped: 0, reason: 'archived' });
    } else if (!hasRunnableCheck(node)) {
      openNodes += 1;
      skippedNodes.push({ relativePath: node.relativePath, id: node.id, outcome: 'skipped', passed: 0, failed: 0, skipped: 0, reason: 'no runnable checks' });
    } else {
      openNodes += 1;
      targets.push(node);
    }
  }

  const nodes: TreeVerificationEntry[] = [];
  for (const node of targets) {
    const child = spawnSync(process.execPath, [entry, 'verify', node.relativePath, ...options.passthrough, '--workspace', options.root, '--json'], {
      cwd: options.root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const envelope = parseChildEnvelope(typeof child.stdout === 'string' ? child.stdout : '');
    const data = envelope?.data as Record<string, any> | undefined;
    const verification = data?.verification as Record<string, any> | undefined;
    const error = envelope?.error?.message ?? childError(child);
    const outcome = data?.result === 'passed' && child.status === 0 ? 'passed' : 'failed';
    const advisories = advisoryMessages(data?.advisories);
    const executionDrift = data?.executionDrift as Record<string, any> | undefined;
    const failedChecks = outcome === 'failed' ? failedCheckDetails(verification) : [];
    const logPath = workspaceEvidencePath(node.relativePath, data?.evidence?.logPath ?? data?.diagnosticLog?.logPath);
    const phase = outcome === 'failed' ? failurePhase(verification?.failurePhase) : undefined;
    nodes.push({
      relativePath: node.relativePath,
      id: node.id,
      outcome,
      passed: Number(verification?.passed ?? 0),
      failed: Number(verification?.failed ?? 0),
      skipped: Number(verification?.skipped ?? 0),
      ...(typeof data?.evidence?.id === 'string' ? { evidenceId: data.evidence.id } : {}),
      ...(typeof data?.observationBasis === 'string' ? { observationBasis: data.observationBasis } : {}),
      ...(advisories.length ? { advisories } : {}),
      ...(data?.drifted === true ? { artifactDrift: true } : {}),
      ...(typeof data?.renderRecovery === 'string' ? { renderRecovery: data.renderRecovery } : {}),
      ...(typeof executionDrift?.status === 'string' && executionDrift.status !== 'current' ? { executionDrift: executionDrift.status } : {}),
      ...(phase === undefined ? {} : { failurePhase: phase }),
      ...(failedChecks.length ? { failedChecks } : {}),
      ...(logPath === undefined ? {} : { logPath }),
      ...(outcome === 'failed' && typeof data?.recovery === 'string' ? { recovery: data.recovery } : {}),
      ...(outcome === 'failed' && error ? { error } : {}),
    });
  }

  const failed = nodes.filter(node => node.outcome === 'failed').length;
  const bases = [...new Set(nodes.map(node => node.observationBasis).filter((basis): basis is 'git' | 'artifact' => basis === 'git' || basis === 'artifact'))];
  const restoreTarget = openNodes === 0 ? await topArchivedAncestor(options.root, subtree.relativePath) : undefined;
  return {
    outcome: failed ? 'failed' : 'passed',
    targets: targets.length,
    openNodes,
    archivedNodes,
    ...(restoreTarget ? { restoreTarget } : {}),
    passed: nodes.length - failed,
    failed,
    skippedCount: skippedNodes.length,
    order: targets.map(node => node.relativePath),
    observationBasis: bases.length === 0 ? 'none' : bases.length === 1 ? bases[0] : 'mixed',
    nodes,
    skippedNodes,
  };
}
