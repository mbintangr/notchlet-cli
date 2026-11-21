import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface HistorySignature {
  signature: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface CheckHistory {
  id: string;
  attempts: number;
  passed: number;
  failed: number;
  skipped: number;
  currentStatus: 'passed' | 'failed' | 'skipped';
  lastFailureAt?: string;
  captures: number;
  signatures: HistorySignature[];
}

export interface PreflightHistory {
  status: 'passed' | 'failed';
  lastAt: string;
  changed: string[];
  firstExitCode: number | null;
  secondExitCode: number | null;
}

export interface AttemptHistory {
  changeId: string;
  logs: number;
  firstAt?: string;
  lastAt?: string;
  outcome?: string;
  readinessFailures: number;
  readinessSignatures: HistorySignature[];
  setupPreflight?: PreflightHistory;
  checks: CheckHistory[];
}

interface LogAssertion { kind?: string; passed?: boolean; expected?: string; observed?: string; }
interface LogStep { index?: number; action?: string; ok?: boolean; detail?: string; }
interface LogCheck {
  id?: string;
  status?: string;
  assertions?: LogAssertion[];
  rendered?: { steps?: LogStep[] };
  capture?: unknown;
  exitCode?: number | null;
  stderr?: string;
}
interface LogPayload {
  capturedAt?: string;
  outcome?: string;
  readiness?: { reached?: boolean; url?: string; error?: string; waitedMs?: number };
  setupPreflight?: {
    status?: string;
    changed?: string[];
    added?: string[];
    removed?: string[];
    firstExitCode?: number | null;
    secondExitCode?: number | null;
  };
  checks?: LogCheck[];
}

function normalize(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function failureSignatures(check: LogCheck): string[] {
  const signatures = new Set<string>();
  for (const assertion of check.assertions ?? []) {
    if (assertion.passed !== false) continue;
    signatures.add(`${normalize(assertion.kind ?? 'assertion')}: ${normalize(assertion.expected)} — ${normalize(assertion.observed)}`);
  }
  for (const step of check.rendered?.steps ?? []) {
    if (step.ok !== false) continue;
    signatures.add(`step ${(step.index ?? 0) + 1}: ${normalize(step.action)} — ${normalize(step.detail)}`);
  }
  if (!signatures.size && check.status === 'failed') {
    const reason = normalize(check.stderr) || `exit ${check.exitCode ?? 'none'}`;
    signatures.add(`check failed: ${reason}`);
  }
  return [...signatures];
}

function readinessSignatures(log: LogPayload): string[] {
  if (log.readiness?.reached !== false) return [];
  return [`readiness not reached: ${normalize(log.readiness.error) || normalize(log.readiness.url) || 'unknown reason'}`];
}

function addSignature(map: Map<string, HistorySignature>, signature: string, at: string): void {
  const current = map.get(signature);
  if (!current) map.set(signature, { signature, count: 1, firstAt: at, lastAt: at });
  else { current.count += 1; current.lastAt = at; }
}

async function logPaths(root: string, changeId: string): Promise<string[]> {
  const candidates = [
    path.join(path.resolve(root), '.notchlet', 'changes', changeId, 'evidence', 'logs'),
    path.join(path.resolve(root), '.notchlet', 'archive', changeId, 'evidence', 'logs'),
  ];
  const files: string[] = [];
  for (const directory of candidates) {
    const entries = await readdir(directory).catch(() => []);
    for (const entry of entries) if (entry.endsWith('.json')) files.push(path.join(directory, entry));
  }
  return files.sort();
}

/** Derive per-check attempt history from verification logs; logs remain the canonical append-only record. */
export async function readAttemptHistory(root: string, changeId: string): Promise<AttemptHistory> {
  const files = await logPaths(root, changeId);
  const checks = new Map<string, { attempts: number; passed: number; failed: number; skipped: number; lastStatus: 'passed' | 'failed' | 'skipped'; lastFailureAt?: string; captures: number; signatures: Map<string, HistorySignature> }>();
  const readiness = new Map<string, HistorySignature>();
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  let outcome: string | undefined;
  let readinessFailures = 0;
  let setupPreflight: PreflightHistory | undefined;
  for (const file of files) {
    let log: LogPayload;
    try { log = JSON.parse(await readFile(file, 'utf8')) as LogPayload; }
    catch { continue; }
    const at = log.capturedAt ?? new Date().toISOString();
    firstAt = firstAt === undefined || at < firstAt ? at : firstAt;
    lastAt = lastAt === undefined || at > lastAt ? at : lastAt;
    outcome = log.outcome ?? outcome;
    if (log.setupPreflight?.status === 'passed' || log.setupPreflight?.status === 'failed') {
      if (setupPreflight === undefined || at >= setupPreflight.lastAt) {
        setupPreflight = {
          status: log.setupPreflight.status,
          lastAt: at,
          changed: [...(log.setupPreflight.changed ?? []), ...(log.setupPreflight.added ?? []), ...(log.setupPreflight.removed ?? [])],
          firstExitCode: log.setupPreflight.firstExitCode ?? null,
          secondExitCode: log.setupPreflight.secondExitCode ?? null,
        };
      }
    }
    for (const signature of readinessSignatures(log)) { addSignature(readiness, signature, at); readinessFailures += 1; }
    for (const check of log.checks ?? []) {
      if (!check.id) continue;
      const entry = checks.get(check.id) ?? { attempts: 0, passed: 0, failed: 0, skipped: 0, lastStatus: 'skipped' as const, captures: 0, signatures: new Map<string, HistorySignature>() };
      entry.attempts += 1;
      if (check.status === 'passed') { entry.passed += 1; entry.lastStatus = 'passed'; }
      else if (check.status === 'failed') { entry.failed += 1; entry.lastStatus = 'failed'; entry.lastFailureAt = at; }
      else { entry.skipped += 1; entry.lastStatus = 'skipped'; }
      if (check.capture !== undefined) entry.captures += 1;
      for (const signature of failureSignatures(check)) addSignature(entry.signatures, signature, at);
      checks.set(check.id, entry);
    }
  }
  return {
    changeId,
    logs: files.length,
    ...(firstAt === undefined ? {} : { firstAt }),
    ...(lastAt === undefined ? {} : { lastAt }),
    ...(outcome === undefined ? {} : { outcome }),
    readinessFailures,
    readinessSignatures: [...readiness.values()].sort((left, right) => right.count - left.count),
    ...(setupPreflight === undefined ? {} : { setupPreflight }),
    checks: [...checks.entries()].map(([id, entry]) => ({
      id,
      attempts: entry.attempts,
      passed: entry.passed,
      failed: entry.failed,
      skipped: entry.skipped,
      currentStatus: entry.lastStatus,
      ...(entry.lastFailureAt === undefined ? {} : { lastFailureAt: entry.lastFailureAt }),
      captures: entry.captures,
      signatures: [...entry.signatures.values()].sort((left, right) => right.count - left.count),
    })),
  };
}

export function summarizeHistory(history: AttemptHistory): string[] {
  if (!history.logs) return ['No verification logs recorded yet. Setup preflight: never ran.'];
  const lines = [
    `Attempts: ${history.logs} recorded log${history.logs === 1 ? '' : 's'}${history.firstAt ? ` from ${history.firstAt}` : ''}${history.lastAt && history.lastAt !== history.firstAt ? ` to ${history.lastAt}` : ''}${history.outcome ? `; last outcome ${history.outcome}` : ''}.`,
  ];
  if (history.setupPreflight) {
    const changed = history.setupPreflight.changed.length ? `; changed ${history.setupPreflight.changed.join(', ')}` : '';
    const exits = `; exits ${history.setupPreflight.firstExitCode ?? 'none'} then ${history.setupPreflight.secondExitCode ?? 'none'}`;
    lines.push(`Setup preflight: ${history.setupPreflight.status} at ${history.setupPreflight.lastAt}${changed}${history.setupPreflight.status === 'failed' ? exits : ''}.`);
  } else {
    lines.push('Setup preflight: never ran.');
  }
  if (history.readinessFailures) {
    lines.push(`Readiness failures: ${history.readinessFailures}.`);
    for (const signature of history.readinessSignatures.slice(0, 3)) lines.push(`- ${signature.count}× ${signature.signature}`);
  }
  for (const check of history.checks) {
    const counts = `${check.passed}/${check.attempts} passed${check.failed ? `, ${check.failed} failed` : ''}${check.skipped ? `, ${check.skipped} skipped` : ''}`;
    lines.push(`${check.id}: ${counts}; current ${check.currentStatus}${check.captures ? `; ${check.captures} capture${check.captures === 1 ? '' : 's'}` : ''}.`);
    for (const signature of check.signatures.slice(0, 3)) lines.push(`  ${signature.count}× ${signature.signature}`);
  }
  return lines;
}
