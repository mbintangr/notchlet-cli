import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveJsonPath, WorkflowError, type Change, type Check, type EvidenceEnvironment, type ScopedTextExpectation, type SetupPreflightEnvironment, type UiCapturePolicy } from '@notchlet/core';
import { capturePage, describeConsoleMessage, type CaptureConsoleMessage, type CaptureStepResult } from './capture.js';

export type CheckStatus = 'passed' | 'failed' | 'skipped';
export type ExecutedCheckKind = 'command' | 'http' | 'manual' | 'ui';
export interface CheckAssertion {
  kind: 'status' | 'body' | 'json' | 'json-contains' | 'json-path' | 'header' | 'selector' | 'text' | 'title' | 'visible' | 'enabled' | 'scoped-text' | 'step' | 'capture' | 'console';
  passed: boolean;
  expected: string;
  observed: string;
  path?: string;
}
export interface CheckResult {
  id: string;
  description: string;
  kind: ExecutedCheckKind;
  declaredKind?: 'browser';
  command?: string;
  url?: string;
  expectedStatus?: number;
  expectedBodyContains?: string;
  expectedJson?: Record<string, unknown>;
  expectedJsonContains?: unknown;
  expectedJsonAt?: Check['expectedJsonAt'];
  expectedHeaders?: Record<string, string>;
  waitFor?: string;
  settleMs?: number;
  expectedSelectors?: string[];
  expectedText?: string;
  expectedTitle?: string;
  expectedVisibleSelectors?: string[];
  expectedEnabledSelectors?: string[];
  expectedScopedText?: ScopedTextExpectation[];
  steps?: Check['steps'];
  captureArtifacts?: UiCapturePolicy;
  expectedNoConsoleErrors?: boolean;
  fullPage?: boolean;
  workingDirectory?: string;
  environment?: Record<string, string>;
  observedStatus?: number;
  assertions?: CheckAssertion[];
  rendered?: {
    title: string;
    fullPage: boolean;
    wait: { settleMs: number; waitFor?: string; waitedMs: number; matched: boolean };
    console: { messages: CaptureConsoleMessage[]; errors: string[] };
    selectors: Record<string, boolean>;
    visible: Record<string, boolean>;
    enabled: Record<string, boolean>;
    scopedText: Record<string, string | null>;
    steps: CaptureStepResult[];
    screenshotBytes: number;
    domBytes: number;
  };
  capture?: {
    policy: UiCapturePolicy;
    screenshotPath?: string;
    domPath?: string;
    screenshotBytes: number;
    domBytes: number;
  };
  status: CheckStatus;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Set when a check was not run because a prerequisite phase failed. */
  blockedBy?: 'readiness' | 'setup';
  /** Non-fatal diagnostics that separate application, environment, and check-authoring causes. */
  hints?: string[];
}
export interface ReadinessResult {
  url: string;
  attempts: number;
  waitedMs: number;
  reached: boolean;
  status?: number;
  /** Set when the owned serve child exited before readiness was confirmed. */
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}
export interface ServeResult {
  command: string;
  target?: string;
  /** False when an already-running server was reused instead of spawning. */
  started: boolean;
  reused: boolean;
  /** Who owns the listener: verify, the setup command, or an explicitly reused external server. */
  ownership?: 'owned' | 'reused';
  startedBy?: 'serve' | 'setup' | 'external';
  ready: boolean;
  waitedMs: number;
  attempts: number;
  port?: number;
  output: string;
  stopped: boolean;
  keepRunning: boolean;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  shutdown?: {
    requested: boolean;
    forced: boolean;
    reason: 'checks-complete' | 'after-checks-failed' | 'teardown-failed' | 'already-exited' | 'left-running';
    expected: boolean;
    durationMs?: number;
    exitCode?: number | null;
    signal?: string | null;
  };
}
export interface CommandPhase {
  command: string;
  status: 'passed' | 'failed';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}
export interface ReadinessObservation {
  reached: boolean;
  status?: number;
  exitCode?: number | null;
  signal?: string | null;
  /** Normalized failure classification, such as exit:7, signal:SIGTERM, timeout, or HTTP:500. */
  errorCode?: string;
}
export interface RepeatOutcome {
  attempt: number;
  outcome: VerifyResult['outcome'];
  readinessReached?: boolean;
  readiness?: ReadinessObservation;
  checks: Array<{ id: string; status: CheckStatus; observation?: string }>;
}
export interface RepeatReadinessSummary {
  stable: boolean;
  observations: ReadinessObservation[];
}
export interface RepeatSummary {
  attempts: number;
  stable: boolean;
  code?: 'state_not_idempotent' | 'state_drift_under_stable_failure' | 'readiness_drift_under_stable_failure';
  differing: string[];
  /** Checks whose status matched but whose failing observations changed between attempts. */
  drifting?: Array<{ checkId: string; observations: string[] }>;
  /** Readiness-phase observations per attempt when the phase ran. */
  readiness?: RepeatReadinessSummary;
  /** Repeat-specific remediation; per-check hints remain on results. */
  hints?: string[];
  /** Whether setup ran before at least one attempt. */
  setupRan: boolean;
  outcomes: RepeatOutcome[];
}
export interface VerifyResult {
  changeId: string;
  runnable: number;
  outcome: 'passed' | 'failed' | 'informational';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: CheckResult[];
  readiness?: ReadinessResult;
  serve?: ServeResult;
  setup?: CommandPhase;
  setupSkippedReason?: string;
  setupPreflight?: SetupPreflightEnvironment;
  teardown?: CommandPhase;
  environment: EvidenceEnvironment;
  commandIsolation?: string[];
  repeat?: RepeatSummary;
  /** Phase that produced a failed outcome; omitted for passing and informational runs. */
  failurePhase?: 'setup' | 'readiness' | 'checks' | 'repeat';
  /** Checks skipped because setup or readiness blocked their execution. */
  blocked?: number;
}

export interface VerifyOptions {
  checkIds?: string[];
  timeoutMs?: number;
  outputLimitBytes?: number;
  /** Workspace-relative override for every check's working directory. */
  workingDirectory?: string;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  /** Start the declared run command and stop it after checks; true uses change.runCommand. */
  serve?: boolean | { command?: string; keepRunning?: boolean; reuse?: boolean };
  /** Explicitly allow --serve to target an already-running listener that verify does not own. */
  reuseServe?: boolean;
  /** Default UI capture policy when a check does not declare one; defaults to on-failure. */
  uiCapture?: UiCapturePolicy;
  environment?: Record<string, string>;
  setupCommand?: string;
  teardownCommand?: string;
  /** Run setup twice before checks and fail when declared state paths differ. */
  setupPreflight?: { statePaths: string[] };
  /** Runs after checks while any served app is still running; failures propagate after cleanup. */
  afterChecks?: () => Promise<void>;
  /** Defaults applied to UI checks that do not declare their own capture settings. */
  capture?: { browser?: string; viewport?: { width: number; height: number }; settleMs?: number; fullPage?: boolean; timeoutMs?: number };
  /** Run the whole check batch N times (setup included) and report state-dependent differences. */
  repeat?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT = 32 * 1024;
const DEFAULT_READY_INTERVAL_MS = 250;
const READINESS_ATTEMPT_LIMIT_MS = 5_000;
const SERVE_EXIT_WAIT_MS = 3_000;
const SERVE_GRACEFUL_WAIT_MS = 1_500;

function truncate(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  const buffer = Buffer.from(value, 'utf8').subarray(0, limit).toString('utf8');
  return `${buffer}\n[output truncated at ${limit} bytes]`;
}

function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, signal);
  } catch { /* the process may already have exited */ }
}

const SERVE_PROCESS_KEYS = ['PORT'];

function declaredEnvironment(change: Change, options: VerifyOptions): Record<string, string> {
  return { ...(change.environment ?? {}), ...(options.environment ?? {}) };
}

function executionEnvironment(change: Change, options: VerifyOptions): NodeJS.ProcessEnv {
  return { ...process.env, ...declaredEnvironment(change, options) };
}

/**
 * Command checks must not inherit the served process's port or ambient server settings.
 * Explicitly declared variables and per-check overrides still apply.
 */
function commandEnvironment(change: Change, options: VerifyOptions, check: Check, serving: boolean): { environment: NodeJS.ProcessEnv; stripped: string[] } {
  const explicit = declaredEnvironment(change, options);
  const environment: NodeJS.ProcessEnv = { ...process.env, ...explicit, ...(check.environment ?? {}) };
  const stripped: string[] = [];
  if (!serving) return { environment, stripped };
  for (const key of SERVE_PROCESS_KEYS) {
    if (key in explicit || (check.environment !== undefined && key in check.environment)) continue;
    if (environment[key] !== undefined) { delete environment[key]; stripped.push(key); }
  }
  return { environment, stripped };
}

function execute(command: string, cwd: string, timeoutMs: number, outputLimit: number, env: NodeJS.ProcessEnv): Promise<Omit<CheckResult, 'id' | 'description' | 'kind' | 'url' | 'expectedStatus' | 'status'>> {
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '', stderr = '';
    let timedOut = false;
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      if (target === 'stdout') stdout = truncate(stdout + chunk.toString('utf8'), outputLimit);
      else stderr = truncate(stderr + chunk.toString('utf8'), outputLimit);
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - started, stdout, stderr });
    };
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, durationMs: Date.now() - started, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

type Mismatch = { path: string; expected: string; observed: string };

/** Recursive subset comparison: every expected key/index must match the observed document. */
function jsonSubsetMismatches(expected: unknown, observed: unknown, location = '$'): Mismatch[] {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(expected, observed) ? [] : [{ path: location, expected: formatValue(expected), observed: formatValue(observed) }];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed)) return [{ path: location, expected: formatValue(expected), observed: formatValue(observed) }];
    const mismatches: Mismatch[] = [];
    if (expected.length !== observed.length) mismatches.push({ path: `${location}.length`, expected: String(expected.length), observed: String(observed.length) });
    for (let index = 0; index < Math.min(expected.length, observed.length); index++) mismatches.push(...jsonSubsetMismatches(expected[index], observed[index], `${location}[${index}]`));
    return mismatches;
  }
  if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) {
    return [{ path: location, expected: formatValue(expected), observed: formatValue(observed) }];
  }
  const mismatches: Mismatch[] = [];
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    const qualified = `${location}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(observed, key)) mismatches.push({ path: qualified, expected: formatValue(value), observed: '(missing)' });
    else mismatches.push(...jsonSubsetMismatches(value, (observed as Record<string, unknown>)[key], qualified));
  }
  return mismatches;
}

/** Subset comparison that tolerates extra keys and extra/unordered array items. */
function jsonContainsMismatches(expected: unknown, observed: unknown, location = '$'): Mismatch[] {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(expected, observed) ? [] : [{ path: location, expected: formatValue(expected), observed: formatValue(observed) }];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed)) return [{ path: location, expected: formatValue(expected), observed: formatValue(observed) }];
    const mismatches: Mismatch[] = [];
    for (let index = 0; index < expected.length; index++) {
      const matches = observed.some(candidate => jsonContainsMismatches(expected[index], candidate, `${location}[${index}]`).length === 0);
      if (!matches) mismatches.push({ path: `${location}[${index}]`, expected: formatValue(expected[index]), observed: `no matching item among ${observed.length}` });
    }
    return mismatches;
  }
  if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) {
    return [{ path: location, expected: formatValue(expected), observed: formatValue(observed) }];
  }
  const mismatches: Mismatch[] = [];
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    const qualified = `${location}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(observed, key)) mismatches.push({ path: qualified, expected: formatValue(value), observed: '(missing)' });
    else mismatches.push(...jsonContainsMismatches(value, (observed as Record<string, unknown>)[key], qualified));
  }
  return mismatches;
}

function describeAssertionFailure(assertion: CheckAssertion): string {
  const prefix = assertion.path === undefined ? assertion.kind : `${assertion.kind} ${assertion.path}`;
  return `${prefix}: expected ${assertion.expected}, observed ${assertion.observed}.`;
}

async function probe(check: Check, timeoutMs: number, outputLimit: number, recoveryHint: string): Promise<Omit<CheckResult, 'id' | 'description' | 'kind' | 'command' | 'url' | 'expectedStatus' | 'expectedBodyContains' | 'expectedJson' | 'expectedJsonContains' | 'expectedJsonAt' | 'expectedHeaders' | 'workingDirectory' | 'status'>> {
  const started = Date.now();
  const expectedStatus = check.expectedStatus ?? 200;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(check.url!, { signal: controller.signal, redirect: 'follow' });
    let body = '';
    try { body = await response.text(); } catch { /* the status remains the primary result */ }
    const assertions: CheckAssertion[] = [{ kind: 'status', passed: response.status === expectedStatus, expected: `HTTP ${expectedStatus}`, observed: `HTTP ${response.status}` }];
    if (check.expectedBodyContains !== undefined) {
      const found = body.includes(check.expectedBodyContains);
      assertions.push({ kind: 'body', passed: found, expected: check.expectedBodyContains, observed: found ? 'present' : 'absent' });
    }
    for (const [header, expected] of Object.entries(check.expectedHeaders ?? {})) {
      const observed = response.headers.get(header);
      assertions.push({ kind: 'header', passed: observed !== null && observed.trim() === expected.trim(), expected: `${header}: ${expected}`, observed: observed ?? '(missing)', path: header });
    }
    const needsJson = check.expectedJson !== undefined || check.expectedJsonContains !== undefined || (check.expectedJsonAt?.length ?? 0) > 0;
    if (needsJson) {
      let parsed: unknown;
      let valid = true;
      try { parsed = JSON.parse(body); } catch { valid = false; }
      if (!valid) {
        assertions.push({ kind: 'json', passed: false, expected: 'valid JSON body', observed: 'unparseable body' });
      } else {
        if (check.expectedJson !== undefined) {
          const mismatches = jsonSubsetMismatches(check.expectedJson, parsed);
          if (mismatches.length === 0) assertions.push({ kind: 'json', passed: true, expected: formatValue(check.expectedJson), observed: 'matched subset' });
          for (const mismatch of mismatches) assertions.push({ kind: 'json', passed: false, expected: mismatch.expected, observed: mismatch.observed, path: mismatch.path });
        }
        if (check.expectedJsonContains !== undefined) {
          const mismatches = jsonContainsMismatches(check.expectedJsonContains, parsed);
          if (mismatches.length === 0) assertions.push({ kind: 'json-contains', passed: true, expected: formatValue(check.expectedJsonContains), observed: 'matched containment' });
          for (const mismatch of mismatches) assertions.push({ kind: 'json-contains', passed: false, expected: mismatch.expected, observed: mismatch.observed, path: mismatch.path });
        }
        for (const assertion of check.expectedJsonAt ?? []) {
          const resolved = resolveJsonPath(parsed, assertion.path);
          if (!resolved.found) {
            assertions.push({ kind: 'json-path', passed: false, expected: 'path to exist', observed: '(missing)', path: assertion.path });
            continue;
          }
          const value = resolved.value;
          const expectedParts: string[] = [];
          let passed = true;
          if ('equals' in assertion) {
            const equal = JSON.stringify(assertion.equals) === JSON.stringify(value);
            expectedParts.push(formatValue(assertion.equals));
            if (!equal) { passed = false; assertions.push({ kind: 'json-path', passed: false, expected: `equals ${formatValue(assertion.equals)}`, observed: formatValue(value), path: assertion.path }); }
          }
          if (assertion.gte !== undefined) {
            expectedParts.push(`>= ${assertion.gte}`);
            if (typeof value !== 'number' || value < assertion.gte) { passed = false; assertions.push({ kind: 'json-path', passed: false, expected: `>= ${assertion.gte}`, observed: formatValue(value), path: assertion.path }); }
          }
          if (assertion.lte !== undefined) {
            expectedParts.push(`<= ${assertion.lte}`);
            if (typeof value !== 'number' || value > assertion.lte) { passed = false; assertions.push({ kind: 'json-path', passed: false, expected: `<= ${assertion.lte}`, observed: formatValue(value), path: assertion.path }); }
          }
          if (assertion.matches !== undefined) {
            expectedParts.push(`matches /${assertion.matches}/`);
            if (typeof value !== 'string' || !new RegExp(assertion.matches).test(value)) { passed = false; assertions.push({ kind: 'json-path', passed: false, expected: `matches /${assertion.matches}/`, observed: formatValue(value), path: assertion.path }); }
          }
          if (passed) assertions.push({ kind: 'json-path', passed: true, expected: expectedParts.join(' and '), observed: formatValue(value), path: assertion.path });
        }
      }
    }
    const failures = assertions.filter(assertion => !assertion.passed);
    return {
      observedStatus: response.status,
      assertions,
      exitCode: failures.length === 0 ? 0 : 1,
      signal: null,
      timedOut,
      durationMs: Date.now() - started,
      stdout: truncate(body, outputLimit),
      stderr: failures.length === 0 ? '' : failures.map(describeAssertionFailure).join('\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      observedStatus: undefined,
      assertions: [{ kind: 'status', passed: false, expected: `HTTP ${expectedStatus}`, observed: timedOut ? 'no response before timeout' : 'request failed' }],
      exitCode: 1,
      signal: null,
      timedOut,
      durationMs: Date.now() - started,
      stdout: '',
      stderr: recoveryHint ? `${message}\n${recoveryHint}` : message,
    };
  } finally { clearTimeout(timer); }
}

async function archiveUiCapture(root: string, changeId: string, check: Check, page: Awaited<ReturnType<typeof capturePage>>, policy: UiCapturePolicy): Promise<NonNullable<CheckResult['capture']>> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const safeCheck = check.id.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'check';
  const directory = path.join(path.resolve(root), '.notchlet', 'changes', changeId, 'evidence', 'captures', runId);
  await mkdir(directory, { recursive: true });
  const screenshot = path.join(directory, `${safeCheck}.png`);
  const dom = path.join(directory, `${safeCheck}.html`);
  await copyFile(page.screenshot.path, screenshot);
  await copyFile(page.dom.path, dom);
  const relative = (absolute: string) => path.relative(path.resolve(root), absolute).split(path.sep).join('/');
  return { policy, screenshotPath: relative(screenshot), domPath: relative(dom), screenshotBytes: page.screenshot.bytes, domBytes: page.dom.bytes };
}

function probeHints(check: Check, page: Awaited<ReturnType<typeof capturePage>>, assertions: CheckAssertion[]): string[] {
  const hints: string[] = [];
  const rendered = page.text;
  for (const [index, step] of page.steps.entries()) {
    if (step.ok) continue;
    const declared = check.steps?.[index];
    if (!declared) continue;
    if ((declared.action === 'assertText' || declared.action === 'waitForText') && declared.text) {
      const textVisibleElsewhere = rendered.includes(declared.text) || (declared.selector !== undefined && (page.scopedText[declared.selector] ?? '').includes(declared.text));
      if (textVisibleElsewhere) {
        hints.push(`timing-or-scope: step ${index + 1} ${declared.action} failed for ${JSON.stringify(declared.text)} although the same text is rendered${declared.selector ? ` within ${declared.selector}` : ''}; add waitForText/waitForVisible before the assertion instead of asserting immediately.`);
      } else if (/^\s*(?:[#.\[][^\s]*|css=|xpath=|text=)/.test(declared.text)) {
        hints.push(`check-authoring: step ${index + 1} ${declared.action} expects ${JSON.stringify(declared.text)}, which looks like a selector; text assertions compare rendered copy. Use a selector field or ${declared.action === 'assertText' ? 'expectedVisibleSelectors' : 'waitForVisible'} instead.`);
      }
    }
    if (declared.action === 'waitForVisible' && declared.selector) {
      const textAppeared = rendered.includes(declared.selector);
      if (textAppeared) hints.push(`check-authoring: step ${index + 1} waitForVisible used ${JSON.stringify(declared.selector)} but that string appears as rendered copy; selectors and expected text may be swapped.`);
    }
  }
  if (check.expectedText && /^\s*(?:[#.\[][^\s]*|css=|xpath=|text=)/.test(check.expectedText)) {
    hints.push(`check-authoring: expectedText ${JSON.stringify(check.expectedText)} looks like a selector; expectedText asserts rendered copy, while expectedVisibleSelectors/expectedSelectors check elements.`);
  }
  const failedText = assertions.some(assertion => !assertion.passed && assertion.kind === 'text');
  const passedStepText = page.steps.some((step, index) => step.ok && check.steps?.[index]?.action === 'assertText');
  if (failedText && passedStepText) hints.push('contradiction: the check-level text assertion failed but an earlier assertText step passed; review whether the assertion targets the intended page or text.');
  return [...new Set(hints)];
}

async function probeUi(check: Check, options: VerifyOptions, timeoutMs: number, outputLimit: number, recoveryHint: string, root: string, changeId: string): Promise<Omit<CheckResult, 'id' | 'description' | 'kind' | 'command' | 'url' | 'expectedStatus' | 'expectedBodyContains' | 'expectedJson' | 'expectedJsonContains' | 'expectedJsonAt' | 'expectedHeaders' | 'waitFor' | 'settleMs' | 'expectedSelectors' | 'expectedText' | 'expectedTitle' | 'expectedVisibleSelectors' | 'expectedEnabledSelectors' | 'expectedScopedText' | 'steps' | 'captureArtifacts' | 'expectedNoConsoleErrors' | 'fullPage' | 'workingDirectory' | 'environment' | 'status'>> {
  const started = Date.now();
  try {
    const page = await capturePage({
      url: check.url!,
      ...(options.capture?.browser === undefined ? {} : { browser: options.capture.browser }),
      ...(options.capture?.viewport === undefined ? {} : { viewport: options.capture.viewport }),
      timeoutMs: options.capture?.timeoutMs ?? timeoutMs,
      ...(check.waitFor === undefined ? {} : { waitFor: check.waitFor }),
      settleMs: check.settleMs ?? options.capture?.settleMs,
      fullPage: check.fullPage ?? options.capture?.fullPage,
      selectors: check.expectedSelectors,
      ...(check.expectedVisibleSelectors === undefined ? {} : { visibleSelectors: check.expectedVisibleSelectors }),
      ...(check.expectedEnabledSelectors === undefined ? {} : { enabledSelectors: check.expectedEnabledSelectors }),
      ...(check.expectedScopedText === undefined ? {} : { scopedText: check.expectedScopedText }),
      ...(check.steps === undefined ? {} : { steps: check.steps }),
    });
    try {
      const assertions: CheckAssertion[] = [];
      const needsHttp = check.expectedStatus !== undefined || check.expectedHeaders !== undefined || check.expectedJson !== undefined || check.expectedJsonContains !== undefined || (check.expectedJsonAt?.length ?? 0) > 0 || check.expectedBodyContains !== undefined;
      const http = needsHttp ? await probe(check, timeoutMs, outputLimit, recoveryHint) : undefined;
      if (http?.assertions) assertions.push(...http.assertions);
      for (const [index, step] of page.steps.entries()) {
        assertions.push({
          kind: 'step',
          passed: step.ok,
          expected: `step ${index + 1}: ${step.action}`,
          observed: step.detail,
          ...(check.steps?.[index]?.selector === undefined ? {} : { path: check.steps[index].selector }),
        });
      }
      if (check.waitFor) assertions.push({ kind: 'selector', passed: true, expected: `selector ${check.waitFor}`, observed: 'present', path: check.waitFor });
      for (const selector of check.expectedSelectors ?? []) {
        const passed = page.selectors[selector] === true;
        assertions.push({ kind: 'selector', passed, expected: `selector ${selector}`, observed: passed ? 'present' : 'absent', path: selector });
      }
      for (const selector of check.expectedVisibleSelectors ?? []) {
        const passed = page.visible[selector] === true;
        assertions.push({ kind: 'visible', passed, expected: `visible selector ${selector}`, observed: passed ? 'visible' : 'hidden or absent', path: selector });
      }
      for (const selector of check.expectedEnabledSelectors ?? []) {
        const passed = page.enabled[selector] === true;
        assertions.push({ kind: 'enabled', passed, expected: `enabled selector ${selector}`, observed: passed ? 'enabled' : 'disabled or absent', path: selector });
      }
      if (check.expectedTitle !== undefined) {
        const passed = page.title === check.expectedTitle;
        assertions.push({ kind: 'title', passed, expected: check.expectedTitle, observed: page.title || '(empty title)' });
      }
      if (check.expectedText !== undefined) {
        const passed = page.text.includes(check.expectedText);
        assertions.push({ kind: 'text', passed, expected: check.expectedText, observed: passed ? 'present in rendered text' : 'absent from rendered text' });
      }
      for (const expectation of check.expectedScopedText ?? []) {
        const text = page.scopedText[expectation.selector];
        const passed = typeof text === 'string' && text.includes(expectation.contains);
        assertions.push({
          kind: 'scoped-text',
          passed,
          expected: `"${expectation.contains}" within ${expectation.selector}`,
          observed: text === null || text === undefined ? 'container absent' : text.length > 500 ? `${text.slice(0, 500)}…` : text,
          path: expectation.selector,
        });
      }
      if (check.expectedNoConsoleErrors === true) {
        assertions.push({ kind: 'console', passed: page.console.errors.length === 0, expected: 'no console errors or uncaught exceptions', observed: page.console.errors.length ? page.console.errors.join(' | ') : 'none' });
      }
      const failures = assertions.filter(assertion => !assertion.passed);
      const hints = failures.length ? probeHints(check, page, assertions) : [];
      const policy = check.captureArtifacts ?? options.uiCapture ?? 'on-failure';
      let captured: CheckResult['capture'];
      if (policy === 'always' || (policy === 'on-failure' && failures.length > 0)) {
        try { captured = await archiveUiCapture(root, changeId, check, page, policy); }
        catch (error) {
          assertions.push({ kind: 'capture', passed: false, expected: 'archived UI capture', observed: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        ...(http?.observedStatus === undefined ? {} : { observedStatus: http.observedStatus }),
        assertions,
        rendered: {
          title: page.title,
          fullPage: page.fullPage,
          wait: page.wait,
          console: page.console,
          selectors: page.selectors,
          visible: page.visible,
          enabled: page.enabled,
          scopedText: page.scopedText,
          steps: page.steps,
          screenshotBytes: page.screenshot.bytes,
          domBytes: page.dom.bytes,
        },
        ...(captured === undefined ? {} : { capture: captured }),
        ...(hints.length ? { hints } : {}),
        exitCode: failures.length === 0 ? 0 : 1,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - started,
        stdout: truncate(page.text, outputLimit),
        stderr: failures.length === 0 ? '' : failures.map(describeAssertionFailure).join('\n'),
      };
    } finally { await page.cleanup(); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      observedStatus: undefined,
      assertions: [{ kind: 'text', passed: false, expected: 'rendered UI capture', observed: message }],
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - started,
      stdout: '',
      stderr: recoveryHint ? `${message}\n${recoveryHint}` : message,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function probeListener(url: string, timeoutMs = 750): Promise<{ status: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function portOf(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)); } catch { return undefined; }
}

type ReadinessExpectation = { expectedStatus?: number; bodyContains?: string };
type PollOutcome = { reached: boolean; attempts: number; waitedMs: number; status?: number; error?: string };

/** Poll until the readiness endpoint returns an acceptable status (default 2xx/3xx) and optional body text. */
async function pollUntil(url: string, timeoutMs: number, intervalMs: number, expectation: ReadinessExpectation = {}, aborted?: () => string | undefined): Promise<PollOutcome> {
  const started = Date.now();
  let attempts = 0;
  let lastError: string | undefined;
  let lastStatusError: string | undefined;
  let lastStatus: number | undefined;
  const acceptable = (status: number): boolean => expectation.expectedStatus === undefined ? status >= 200 && status < 400 : status === expectation.expectedStatus;
  while (true) {
    const abortReason = aborted?.();
    if (abortReason !== undefined) return { reached: false, attempts, waitedMs: Date.now() - started, error: abortReason };
    attempts++;
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, READINESS_ATTEMPT_LIMIT_MS));
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      lastStatus = response.status;
      if (acceptable(response.status)) {
        if (expectation.bodyContains === undefined) {
          await response.body?.cancel().catch(() => undefined);
          return { reached: true, attempts, waitedMs: Date.now() - started, status: response.status };
        }
        const body = await response.text();
        if (body.includes(expectation.bodyContains)) return { reached: true, attempts, waitedMs: Date.now() - started, status: response.status };
        lastStatusError = `readiness body did not contain "${expectation.bodyContains}"`;
      } else {
        await response.body?.cancel().catch(() => undefined);
        lastStatusError = expectation.expectedStatus === undefined
          ? `readiness returned HTTP ${response.status}; expected 2xx or 3xx`
          : `readiness returned HTTP ${response.status}; expected ${expectation.expectedStatus}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally { clearTimeout(timer); }
    const abortAfterAttempt = aborted?.();
    if (abortAfterAttempt !== undefined) return { reached: false, attempts, waitedMs: Date.now() - started, error: abortAfterAttempt };
    if (Date.now() - started >= timeoutMs) {
      // An answered-but-unacceptable response is more useful than a final abort error.
      const error = lastStatusError ?? lastError;
      return { reached: false, attempts, waitedMs: Date.now() - started, ...(lastStatus === undefined ? {} : { status: lastStatus }), ...(error === undefined ? {} : { error }) };
    }
    await sleep(Math.min(Math.max(1, intervalMs), Math.max(1, timeoutMs - (Date.now() - started))));
  }
}

function describeExit(exitCode: number | null, signal: string | null): string {
  if (exitCode !== null) return `with exit code ${exitCode}`;
  if (signal !== null) return `after signal ${signal}`;
  return 'without an exit code';
}

function kindOf(check: Check): ExecutedCheckKind {
  if (check.kind === 'browser' || check.kind === 'http') return 'http';
  if (check.kind === 'ui') return 'ui';
  if (check.kind === 'command' || check.kind === 'manual') return check.kind;
  return check.command?.trim() ? 'command' : check.url?.trim() ? 'http' : 'manual';
}

function workspaceDirectory(root: string, change: Change, override?: string): string {
  const relative = override ?? change.workingDirectory;
  const base = path.resolve(root);
  if (relative === undefined) return base;
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new WorkflowError('invalid_working_directory', `Working directory escapes the workspace: ${relative}`, 'Declare a workspace-relative working directory that stays inside the workspace.');
  }
  return resolved;
}

function workingDirectoryFor(root: string, change: Change, check: Check, override: string | undefined): string {
  return workspaceDirectory(root, change, override ?? check.workingDirectory);
}

function recoveryHint(change: Change, check: Check, readiness: ReadinessResult | undefined): string {
  const steps: string[] = [];
  if (change.runCommand) steps.push(`Start the app with \`${change.runCommand}\` or let verify own it with \`notchlet verify ${change.id} --serve\`.`);
  if (check.url) steps.push(`Confirm ${check.url} responds.`);
  if (change.readinessUrl) {
    const outcome = readiness === undefined ? 'was not polled' : readiness.reached ? `became reachable after ${readiness.waitedMs}ms` : `did not become reachable within ${change.readyTimeoutMs ?? 0}ms`;
    steps.push(`Readiness probe ${change.readinessUrl} ${outcome}${readiness?.error ? ` (${readiness.error})` : ''}.`);
  }
  if (change.readyTimeoutMs !== undefined) steps.push(`Increase readyTimeoutMs (currently ${change.readyTimeoutMs}ms) if startup is slower than expected.`);
  return steps.length === 0 ? 'Start the service the check targets, then run verify again.' : steps.join(' ');
}

interface ServeSession {
  child: ReturnType<typeof spawn>;
  output: () => string;
  exited: () => boolean;
  exitCode: () => number | null;
  signal: () => NodeJS.Signals | null;
  waitForExit: (timeoutMs?: number) => Promise<boolean>;
}

function startServeProcess(command: string, cwd: string, env: NodeJS.ProcessEnv, outputLimit: number): ServeSession {
  const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const collect = (chunk: Buffer) => { output = truncate(output + chunk.toString('utf8'), outputLimit); };
  child.stdout?.on('data', (chunk: Buffer) => collect(chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect(chunk));
  const closedPromise = new Promise<void>(resolve => {
    child.on('error', error => { output = truncate(`${output}\n${error.message}`.trim(), outputLimit); closed = true; resolve(); });
    child.on('close', (code, signal) => { exitCode = code; exitSignal = signal; closed = true; resolve(); });
  });
  return {
    child,
    output: () => output,
    exited: () => closed,
    exitCode: () => exitCode,
    signal: () => exitSignal,
    waitForExit: async (timeoutMs = SERVE_EXIT_WAIT_MS) => Promise.race([closedPromise.then(() => true), sleep(timeoutMs).then(() => false)]),
  };
}

async function stopServeSession(session: ServeSession, reason: NonNullable<ServeResult['shutdown']>['reason']): Promise<NonNullable<ServeResult['shutdown']>> {
  if (session.exited()) {
    return { requested: false, forced: false, reason: 'already-exited', expected: false, durationMs: 0, exitCode: session.exitCode(), signal: session.signal() };
  }
  const started = Date.now();
  const pid = session.child.pid;
  let forced = false;
  let exited: boolean;
  if (process.platform === 'win32') {
    // A shell-launched server leaves a grandchild holding the stdio pipes; signal the whole tree.
    forced = true;
    killTree(pid);
    exited = await session.waitForExit(SERVE_EXIT_WAIT_MS);
  } else {
    killTree(pid, 'SIGTERM');
    exited = await session.waitForExit(SERVE_GRACEFUL_WAIT_MS);
    if (!exited) {
      forced = true;
      killTree(pid);
      exited = await session.waitForExit(SERVE_EXIT_WAIT_MS);
    }
  }
  if (!exited) throw new Error(`Served app ${reason === 'checks-complete' ? 'did not stop' : `did not stop after ${reason}`}; stop it manually.`);
  return {
    requested: true,
    forced,
    reason,
    expected: true,
    durationMs: Date.now() - started,
    exitCode: session.exitCode(),
    signal: session.signal(),
  };
}

function environmentDescriptor(change: Change, root: string, options: VerifyOptions): EvidenceEnvironment {
  return {
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    cwd: path.relative(path.resolve(root), process.cwd()) || '.',
    ...((change.environment ?? options.environment) === undefined ? {} : { environment: { ...(change.environment ?? {}), ...(options.environment ?? {}) } }),
    ...(change.setupCommand === undefined && options.setupCommand === undefined ? {} : { setupCommand: options.setupCommand ?? change.setupCommand }),
    ...(change.teardownCommand === undefined && options.teardownCommand === undefined ? {} : { teardownCommand: options.teardownCommand ?? change.teardownCommand }),
  };
}

const SETUP_SNAPSHOT_ENTRY_LIMIT = 5_000;

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function snapshotSetupState(baseCwd: string, statePaths: string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const visit = async (absolute: string, relative: string): Promise<void> => {
    if (snapshot.size >= SETUP_SNAPSHOT_ENTRY_LIMIT) {
      throw new WorkflowError('setup_state_too_large', `Setup state snapshot exceeded ${SETUP_SNAPSHOT_ENTRY_LIMIT} files.`, 'Declare narrower --setup-state file or directory paths.');
    }
    let info;
    try { info = await lstat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      const entries = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) await visit(path.join(absolute, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
      return;
    }
    if (!info.isFile()) return;
    snapshot.set(relative, await hashFile(absolute));
  };
  for (const declared of statePaths) {
    const resolved = path.resolve(baseCwd, declared);
    if (resolved !== baseCwd && !resolved.startsWith(baseCwd + path.sep)) {
      throw new WorkflowError('invalid_setup_state_path', `Setup state path escapes the working directory: ${declared}`, 'Declare a path inside the change working directory.');
    }
    await visit(resolved, path.relative(baseCwd, resolved).split(path.sep).join('/'));
  }
  return snapshot;
}

function compareSetupSnapshots(before: Map<string, string>, after: Map<string, string>): { added: string[]; removed: string[]; changed: string[] } {
  const added = [...after.keys()].filter(key => !before.has(key)).sort();
  const removed = [...before.keys()].filter(key => !after.has(key)).sort();
  const changed = [...after.keys()].filter(key => before.has(key) && before.get(key) !== after.get(key)).sort();
  return { added, removed, changed };
}

async function runSetupPreflight(root: string, change: Change, options: VerifyOptions): Promise<SetupPreflightEnvironment> {
  const statePaths = options.setupPreflight?.statePaths ?? [];
  const setupCommand = options.setupCommand ?? change.setupCommand;
  if (!setupCommand) throw new WorkflowError('setup_required', 'Setup idempotence preflight requires a setup command.', 'Provide --setup <cmd> or persist one with --setup <cmd> --save-setup.');
  if (statePaths.length === 0) throw new WorkflowError('setup_state_required', 'Setup idempotence preflight requires at least one --setup-state path.', 'Declare the files or directories that setup must reproduce.');
  const baseCwd = workspaceDirectory(root, change);
  const timeoutMs = options.timeoutMs ?? (Number(process.env.NOTCHLET_VERIFY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const outputLimit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  const env = executionEnvironment(change, options);
  const started = Date.now();
  const recovery = `Fix \`${setupCommand}\` so ${statePaths.join(', ')} is identical after two runs, then rerun with --check-setup-idempotence --setup-state ${statePaths.join(' ')}.`;
  const first = await execute(setupCommand, baseCwd, timeoutMs, outputLimit, env);
  if (first.exitCode !== 0 || first.timedOut) {
    return {
      status: 'failed', statePaths, added: [], removed: [], changed: [],
      firstExitCode: first.exitCode, secondExitCode: null, durationMs: Date.now() - started,
      recovery,
      note: 'Setup failed on the first run; declared state was not snapshotted.',
    };
  }
  const before = await snapshotSetupState(baseCwd, statePaths);
  const second = await execute(setupCommand, baseCwd, timeoutMs, outputLimit, env);
  const after = await snapshotSetupState(baseCwd, statePaths);
  const diff = compareSetupSnapshots(before, after);
  const status = second.exitCode === 0 && !second.timedOut && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 ? 'passed' : 'failed';
  return {
    status, statePaths, ...diff, firstExitCode: first.exitCode, secondExitCode: second.exitCode, durationMs: Date.now() - started,
    ...(status === 'failed' ? { recovery, note: 'Setup ran twice; declared state reflects the second run.' } : {}),
  };
}

function failedSetupPreflightResult(root: string, change: Change, options: VerifyOptions, preflight: SetupPreflightEnvironment): VerifyResult {
  const selected = options.checkIds?.length ? new Set(options.checkIds) : null;
  const checks = change.checks.filter(check => !selected || selected.has(check.id));
  const results: CheckResult[] = checks.map(check => ({
    id: check.id,
    description: check.description,
    kind: kindOf(check),
    status: 'skipped',
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: '',
    stderr: 'Setup idempotence preflight failed; checks were not run.',
    blockedBy: 'setup',
  }));
  return {
    changeId: change.id,
    runnable: 0,
    outcome: 'failed',
    total: results.length,
    passed: 0,
    failed: 0,
    skipped: results.length,
    results,
    failurePhase: 'setup',
    ...(results.length === 0 ? {} : { blocked: results.length }),
    setupPreflight: preflight,
    environment: { ...environmentDescriptor(change, root, options), setupPreflight: preflight },
  };
}

function withSetupPreflight(result: VerifyResult, preflight: SetupPreflightEnvironment): VerifyResult {
  return { ...result, setupPreflight: preflight, environment: { ...result.environment, setupPreflight: preflight } };
}

/** Run setup/teardown commands and (optionally) own the app lifecycle around command and HTTP checks. */
async function runChecksOnce(root: string, change: Change, options: VerifyOptions = {}): Promise<VerifyResult> {
  const selected = options.checkIds?.length ? new Set(options.checkIds) : null;
  const checks = change.checks.filter(check => !selected || selected.has(check.id));
  const timeoutMs = options.timeoutMs ?? (Number(process.env.NOTCHLET_VERIFY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const outputLimit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  const readyTimeoutMs = options.readyTimeoutMs ?? change.readyTimeoutMs ?? 0;
  const readyIntervalMs = options.readyIntervalMs ?? change.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const env = executionEnvironment(change, options);
  const baseCwd = workspaceDirectory(root, change);
  const environment = environmentDescriptor(change, root, options);
  const httpChecks = checks.some(check => kindOf(check) === 'http' || kindOf(check) === 'ui');
  const readinessExpectation: ReadinessExpectation = {
    ...(change.readinessExpectedStatus === undefined ? {} : { expectedStatus: change.readinessExpectedStatus }),
    ...(change.readinessBodyContains === undefined ? {} : { bodyContains: change.readinessBodyContains }),
  };

  const serveOption = options.serve;
  const serveCommand = serveOption === true ? change.runCommand : serveOption && typeof serveOption === 'object' ? serveOption.command ?? change.runCommand : undefined;
  const keepRunning = serveOption !== undefined && typeof serveOption === 'object' && serveOption.keepRunning === true;
  const reuseRequested = options.reuseServe === true || (serveOption !== undefined && typeof serveOption === 'object' && serveOption.reuse === true);
  const serveTarget = change.readinessUrl ?? change.previewUrl ?? checks.find(check => check.url)?.url;
  const servePort = portOf(serveTarget);

  // Ownership is decided before setup runs so preparation never targets a listener verify does not own.
  let serve: ServeResult | undefined;
  let serveSession: ServeSession | undefined;
  let readiness: ReadinessResult | undefined;
  let setupSkippedReason: string | undefined;
  let reuseExisting = false;
  if (serveOption && serveCommand && serveTarget) {
    const existing = await probeListener(serveTarget);
    if (existing) {
      if (!reuseRequested) {
        throw new WorkflowError(
          'serve_port_in_use',
          `A server is already listening at ${serveTarget} (HTTP ${existing.status}), but verify did not start it.`,
          'Stop the existing server, choose another port, or pass --reuse-serve to target it explicitly.',
        );
      }
      reuseExisting = true;
      serve = {
        command: serveCommand, target: serveTarget, started: false, reused: true, ownership: 'reused', startedBy: 'external',
        ready: true, waitedMs: 0, attempts: 1, ...(servePort === undefined ? {} : { port: servePort }), output: '', stopped: false, keepRunning,
      };
      readiness = { url: serveTarget, attempts: 1, waitedMs: 0, reached: true, status: existing.status };
    }
  }

  let setup: CommandPhase | undefined;
  const setupCommand = options.setupCommand ?? change.setupCommand;
  if (setupCommand) {
    if (reuseExisting) {
      setupSkippedReason = 'Setup was skipped because verify reused an existing server it does not own.';
    } else {
      const execution = await execute(setupCommand, baseCwd, timeoutMs, outputLimit, env);
      setup = {
        command: setupCommand,
        status: execution.exitCode === 0 && !execution.timedOut ? 'passed' : 'failed',
        exitCode: execution.exitCode, signal: execution.signal, timedOut: execution.timedOut,
        durationMs: execution.durationMs, stdout: execution.stdout, stderr: execution.stderr,
      };
    }
  }

  if (serveOption && serveCommand && setup?.status !== 'failed' && !reuseExisting) {
    const postSetup = serveTarget ? await probeListener(serveTarget) : null;
    if (postSetup) {
      // The setup command started the listener; verify owns the lifecycle by provenance even without the PID.
      serve = {
        command: serveCommand, ...(serveTarget === undefined ? {} : { target: serveTarget }), started: false, reused: false, ownership: 'owned', startedBy: 'setup',
        ready: true, waitedMs: 0, attempts: 1, ...(servePort === undefined ? {} : { port: servePort }), output: '', stopped: false, keepRunning,
      };
      readiness = { url: serveTarget!, attempts: 1, waitedMs: 0, reached: true, status: postSetup.status };
    } else {
      const startedAt = Date.now();
      serveSession = startServeProcess(serveCommand, baseCwd, env, outputLimit);
      const waitMs = readyTimeoutMs > 0 ? readyTimeoutMs : serveTarget ? 10_000 : 1_500;
      const outcome: PollOutcome = serveTarget
        ? await pollUntil(serveTarget, waitMs, readyIntervalMs, readinessExpectation, () => serveSession!.exited() ? 'The run command exited before readiness was confirmed.' : undefined)
        : await (sleep(waitMs).then(() => ({ reached: true, attempts: 0, waitedMs: Date.now() - startedAt })));
      const exited = serveSession.exited();
      const exitDetail = exited ? `The run command exited ${describeExit(serveSession.exitCode(), serveSession.signal())} before readiness was confirmed.` : undefined;
      serve = {
        command: serveCommand,
        ...(serveTarget === undefined ? {} : { target: serveTarget }),
        started: true,
        reused: false,
        ownership: 'owned',
        startedBy: 'serve',
        ready: outcome.reached && !exited,
        waitedMs: Date.now() - startedAt,
        attempts: outcome.attempts,
        ...(servePort === undefined ? {} : { port: servePort }),
        output: serveSession.output(),
        stopped: false,
        keepRunning,
        ...(exited ? { exitCode: serveSession.exitCode(), signal: serveSession.signal(), error: exitDetail } : {}),
        ...(outcome.reached || exited || serveTarget === undefined ? {} : { error: outcome.error ?? `Readiness was not reached within ${waitMs}ms.` }),
      };
      if (serveTarget) {
        const reached = outcome.reached && !exited;
        readiness = {
          url: serveTarget,
          attempts: outcome.attempts,
          waitedMs: outcome.waitedMs,
          reached,
          ...(outcome.status === undefined ? {} : { status: outcome.status }),
          ...(exited ? { exitCode: serveSession.exitCode(), signal: serveSession.signal() } : {}),
          ...(reached ? {} : { error: exitDetail ?? outcome.error ?? `Readiness was not reached within ${waitMs}ms.` }),
        };
      } else if (outcome.reached) {
        readiness = { url: serveTarget!, attempts: outcome.attempts, waitedMs: outcome.waitedMs, reached: true, ...(outcome.status === undefined ? {} : { status: outcome.status }) };
      }
    }
  } else if (change.readinessUrl && readyTimeoutMs > 0 && httpChecks) {
    const outcome = await pollUntil(change.readinessUrl, readyTimeoutMs, readyIntervalMs, readinessExpectation);
    readiness = { url: change.readinessUrl, ...outcome };
  }

  const results: CheckResult[] = [];
  const setupFailed = setup?.status === 'failed';
  // Gate only startup failures with no HTTP response: a responding-but-unready server can still answer other routes.
  const readinessBlocked = serve?.ownership === 'owned' && serve.ready === false && readiness?.status === undefined;
  const readinessBlockedReason = readiness?.error ?? serve?.error ?? 'readiness was not reached';
  const commandIsolation = new Set<string>();
  for (const check of checks) {
    const kind = kindOf(check);
    const cwd = workingDirectoryFor(root, change, check, options.workingDirectory);
    const base = {
      id: check.id,
      description: check.description,
      kind,
      ...(check.kind === 'browser' ? { declaredKind: 'browser' as const } : {}),
      ...(check.command === undefined ? {} : { command: check.command }),
      ...(check.url === undefined ? {} : { url: check.url }),
      ...(check.expectedStatus === undefined ? {} : { expectedStatus: check.expectedStatus }),
      ...(check.expectedBodyContains === undefined ? {} : { expectedBodyContains: check.expectedBodyContains }),
      ...(check.expectedJson === undefined ? {} : { expectedJson: check.expectedJson }),
      ...(check.expectedJsonContains === undefined ? {} : { expectedJsonContains: check.expectedJsonContains }),
      ...(check.expectedJsonAt === undefined ? {} : { expectedJsonAt: check.expectedJsonAt }),
      ...(check.expectedHeaders === undefined ? {} : { expectedHeaders: check.expectedHeaders }),
      ...(check.waitFor === undefined ? {} : { waitFor: check.waitFor }),
      ...(check.settleMs === undefined ? {} : { settleMs: check.settleMs }),
      ...(check.expectedSelectors === undefined ? {} : { expectedSelectors: check.expectedSelectors }),
      ...(check.expectedText === undefined ? {} : { expectedText: check.expectedText }),
      ...(check.expectedTitle === undefined ? {} : { expectedTitle: check.expectedTitle }),
      ...(check.expectedVisibleSelectors === undefined ? {} : { expectedVisibleSelectors: check.expectedVisibleSelectors }),
      ...(check.expectedEnabledSelectors === undefined ? {} : { expectedEnabledSelectors: check.expectedEnabledSelectors }),
      ...(check.expectedScopedText === undefined ? {} : { expectedScopedText: check.expectedScopedText }),
      ...(check.steps === undefined ? {} : { steps: check.steps }),
      ...(check.captureArtifacts === undefined ? {} : { captureArtifacts: check.captureArtifacts }),
      ...(check.expectedNoConsoleErrors === undefined ? {} : { expectedNoConsoleErrors: check.expectedNoConsoleErrors }),
      ...(check.fullPage === undefined ? {} : { fullPage: check.fullPage }),
      ...(check.workingDirectory === undefined ? {} : { workingDirectory: check.workingDirectory }),
      ...(check.environment === undefined ? {} : { environment: check.environment }),
    };
    if (setupFailed) {
      results.push({ ...base, status: 'skipped', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: 'Setup command failed; checks were not run.', blockedBy: 'setup' });
      continue;
    }
    if (kind === 'manual' || (kind === 'command' && !check.command?.trim()) || ((kind === 'http' || kind === 'ui') && !check.url?.trim())) {
      results.push({ ...base, status: 'skipped', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: kind === 'manual' ? 'Manual check; record its observed outcome and attach supporting evidence.' : 'Check is missing the command or URL required by its kind.' });
      continue;
    }
    if (readinessBlocked && (kind === 'http' || kind === 'ui')) {
      results.push({
        ...base, status: 'skipped', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdout: '',
        stderr: `App never became ready: ${readinessBlockedReason}`,
        blockedBy: 'readiness',
      });
      continue;
    }
    const commandEnv = kind === 'command' ? commandEnvironment(change, options, check, serve !== undefined) : undefined;
    if (commandEnv) for (const key of commandEnv.stripped) commandIsolation.add(key);
    const execution = kind === 'http'
      ? await probe(check, timeoutMs, outputLimit, recoveryHint(change, check, readiness))
      : kind === 'ui'
        ? await probeUi(check, options, timeoutMs, outputLimit, recoveryHint(change, check, readiness), root, change.id)
        : await execute(check.command!, cwd, timeoutMs, outputLimit, commandEnv!.environment);
    const status: CheckStatus = execution.exitCode === 0 && !execution.timedOut ? 'passed' : 'failed';
    const readinessContext = readinessBlocked && kind === 'command'
      ? ['Readiness was not reached; this command check does not prove the server contract.']
      : undefined;
    results.push({ ...base, status, ...execution, ...(readinessContext === undefined ? {} : { hints: readinessContext }) });
  }

  let teardown: CommandPhase | undefined;
  let afterChecksError: unknown;
  try { await options.afterChecks?.(); }
  catch (error) { afterChecksError = error; }
  const teardownCommand = options.teardownCommand ?? change.teardownCommand;
  if (teardownCommand) {
    const execution = await execute(teardownCommand, baseCwd, timeoutMs, outputLimit, env);
    teardown = {
      command: teardownCommand,
      status: execution.exitCode === 0 && !execution.timedOut ? 'passed' : 'failed',
      exitCode: execution.exitCode, signal: execution.signal, timedOut: execution.timedOut,
      durationMs: execution.durationMs, stdout: execution.stdout, stderr: execution.stderr,
    };
  }

  if (serve && serveSession) {
    const reason = afterChecksError !== undefined ? 'after-checks-failed' : teardown?.status === 'failed' ? 'teardown-failed' : 'checks-complete';
    const shutdown = keepRunning
      ? { requested: false, forced: false, reason: 'left-running' as const, expected: true }
      : await stopServeSession(serveSession, reason);
    serve = {
      ...serve,
      output: serveSession.output(),
      stopped: !keepRunning,
      shutdown,
      ...(serveSession.exited() ? { exitCode: serveSession.exitCode(), signal: serveSession.signal() } : {}),
    };
  }

  if (afterChecksError !== undefined) throw afterChecksError;

  const passed = results.filter(result => result.status === 'passed').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const skipped = results.filter(result => result.status === 'skipped').length;
  const runnable = passed + failed;
  const phaseFailed = setupFailed || teardown?.status === 'failed' || serve?.ready === false;
  const outcome: VerifyResult['outcome'] = failed || phaseFailed ? 'failed' : runnable ? 'passed' : 'informational';
  const blocked = results.filter(result => result.blockedBy !== undefined).length;
  const failurePhase: VerifyResult['failurePhase'] = outcome !== 'failed'
    ? undefined
    : setupFailed || teardown?.status === 'failed'
      ? 'setup'
      : (readiness !== undefined && !readiness.reached) || serve?.ready === false
        ? 'readiness'
        : 'checks';
  const isolated = [...commandIsolation].sort();
  return {
    changeId: change.id,
    runnable,
    outcome,
    total: results.length,
    passed,
    failed,
    skipped,
    results,
    ...(failurePhase === undefined ? {} : { failurePhase }),
    ...(blocked === 0 ? {} : { blocked }),
    ...(readiness === undefined ? {} : { readiness }),
    ...(serve === undefined ? {} : { serve }),
    ...(setup === undefined ? {} : { setup }),
    ...(setupSkippedReason === undefined ? {} : { setupSkippedReason }),
    ...(teardown === undefined ? {} : { teardown }),
    ...(isolated.length === 0 ? {} : { commandIsolation: isolated }),
    environment: { ...environment, ...(isolated.length === 0 ? {} : { commandIsolation: isolated }) },
  };
}

function compactObservation(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function observationFingerprint(result: CheckResult): string | undefined {
  const failures = (result.assertions ?? [])
    .filter(assertion => !assertion.passed)
    .map(assertion => `${assertion.kind}${assertion.path === undefined ? '' : ` ${assertion.path}`}: expected ${assertion.expected}; observed ${assertion.observed}`)
    .sort();
  return failures.length === 0 ? undefined : compactObservation(failures.join('; '));
}

function readinessErrorCode(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const exit = /exit code (-?\d+)/i.exec(error);
  if (exit) return `exit:${exit[1]}`;
  const signal = /signal ([A-Z0-9]+)/i.exec(error);
  if (signal) return `signal:${signal[1]}`;
  const http = /HTTP (\d{3})/i.exec(error);
  if (http) return `HTTP:${http[1]}`;
  const network = /\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b/i.exec(error);
  if (network) return `network:${network[1].toUpperCase()}`;
  if (/timed out|timeout/i.test(error)) return 'timeout';
  if (/body did not contain/i.test(error)) return 'body_mismatch';
  return undefined;
}

function readinessObservation(readiness: ReadinessResult | undefined): ReadinessObservation | undefined {
  if (!readiness) return undefined;
  const errorCode = readinessErrorCode(readiness.error);
  return {
    reached: readiness.reached,
    ...(readiness.status === undefined ? {} : { status: readiness.status }),
    ...(readiness.exitCode === undefined ? {} : { exitCode: readiness.exitCode }),
    ...(readiness.signal === undefined ? {} : { signal: readiness.signal }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function readinessFingerprint(observation: ReadinessObservation | undefined): string {
  return JSON.stringify([
    observation?.reached ?? null,
    observation?.status ?? null,
    observation?.exitCode ?? null,
    observation?.signal ?? null,
    observation?.errorCode ?? null,
  ]);
}

export function describeReadinessObservation(observation: ReadinessObservation | undefined): string {
  if (!observation) return 'not run';
  const details: string[] = [];
  if (observation.status !== undefined) details.push(`HTTP ${observation.status}`);
  if (observation.exitCode !== undefined) details.push(`exit ${observation.exitCode ?? 'none'}`);
  if (observation.signal) details.push(`signal ${observation.signal}`);
  const redundantCode = observation.errorCode !== undefined && (
    (observation.exitCode !== undefined && observation.errorCode === `exit:${observation.exitCode}`)
    || (observation.status !== undefined && observation.errorCode === `HTTP:${observation.status}`)
    || (observation.signal !== undefined && observation.errorCode === `signal:${observation.signal}`)
  );
  if (observation.errorCode && !redundantCode) details.push(observation.errorCode);
  return `${observation.reached ? 'reached' : 'not reached'}${details.length ? ` (${details.join(', ')})` : ''}`;
}

export async function runChecks(root: string, change: Change, options: VerifyOptions = {}): Promise<VerifyResult> {
  const preflight = options.setupPreflight ? await runSetupPreflight(root, change, options) : undefined;
  if (preflight?.status === 'failed') return failedSetupPreflightResult(root, change, options, preflight);
  const attempts = options.repeat ?? 1;
  if (attempts <= 1) {
    const result = await runChecksOnce(root, change, options);
    return preflight === undefined ? result : withSetupPreflight(result, preflight);
  }
  const runs: VerifyResult[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) runs.push(await runChecksOnce(root, change, options));
  const statusMap = (result: VerifyResult) => new Map(result.results.map(check => [check.id, check.status]));
  const observationMap = (result: VerifyResult) => new Map(result.results.map(check => [check.id, observationFingerprint(check)]));
  const baseline = statusMap(runs[0]);
  const observations = runs.map(observationMap);
  const differing = [...baseline.keys()].filter(id => runs.some(run => statusMap(run).get(id) !== baseline.get(id)));
  const drifting: Array<{ checkId: string; observations: string[] }> = [...baseline.keys()].flatMap(checkId => {
    if (differing.includes(checkId)) return [];
    const values = observations.map(map => map.get(checkId));
    if (new Set(values).size <= 1) return [];
    return [{ checkId, observations: values.map(value => value === undefined ? '(no failing assertion)' : value) }];
  });
  const stableOutcome = runs.every(run => run.outcome === runs[0].outcome);
  const readinessObservations = runs.map(run => readinessObservation(run.readiness));
  const readinessValues = readinessObservations.map(readinessFingerprint);
  const readinessDrift = readinessValues.some(value => value !== readinessValues[0]);
  const statusDrift = differing.length > 0 || !stableOutcome;
  const stable = !statusDrift && drifting.length === 0 && !readinessDrift;
  const outcomes: RepeatOutcome[] = runs.map((run, index) => ({
    attempt: index + 1,
    outcome: run.outcome,
    ...(run.readiness === undefined ? {} : { readinessReached: run.readiness.reached }),
    ...(readinessObservations[index] === undefined ? {} : { readiness: readinessObservations[index] }),
    checks: run.results.map(check => {
      const observation = observations[index].get(check.id);
      return { id: check.id, status: check.status, ...(observation === undefined ? {} : { observation }) };
    }),
  }));
  const setupRan = runs.some(run => run.setup?.status === 'passed');
  const base = runs.find(run => run.outcome === 'failed') ?? runs.at(-1)!;
  const repeatHints: string[] = [];
  const setupSuspicion = setupRan ? ' Setup ran before each attempt; verify it restores state, or rerun with --check-setup-idempotence --setup-state <path>.' : ' Reruns mutate state or timing differs.';
  const results = base.results.map(check => {
    if (differing.includes(check.id)) {
      const sequence = runs.map(run => statusMap(run).get(check.id) ?? 'skipped').join(' → ');
      const hint = `repeat: ${check.id} changed across ${attempts} attempts (${sequence}); reruns depend on prior state or timing.`;
      repeatHints.push(hint);
      return { ...check, hints: [...(check.hints ?? []), hint] };
    }
    const drift = drifting.find(entry => entry.checkId === check.id);
    if (!drift) return check;
    const hint = `repeat: ${check.id} kept status ${check.status} across ${attempts} attempts but the observed failure changed (${drift.observations.join(' → ')}).${setupSuspicion}`;
    repeatHints.push(hint);
    return { ...check, hints: [...(check.hints ?? []), hint] };
  });
  if (readinessDrift) {
    const sequence = readinessObservations.map(describeReadinessObservation).join(' → ');
    const hint = `repeat readiness: observations changed across ${attempts} attempts (${sequence}) while the batch outcome stayed ${runs[0].outcome}.${setupSuspicion}`;
    repeatHints.push(hint);
  }
  const summary: RepeatSummary = {
    attempts,
    stable,
    ...(stable ? {} : { code: statusDrift ? 'state_not_idempotent' as const : drifting.length > 0 ? 'state_drift_under_stable_failure' as const : 'readiness_drift_under_stable_failure' as const }),
    differing,
    ...(drifting.length === 0 ? {} : { drifting }),
    ...(readinessObservations.every(observation => observation === undefined) ? {} : { readiness: { stable: !readinessDrift, observations: readinessObservations.filter((observation): observation is ReadinessObservation => observation !== undefined) } }),
    ...(repeatHints.length === 0 ? {} : { hints: repeatHints }),
    setupRan,
    outcomes,
  };
  const combined: VerifyResult = { ...base, results, outcome: stable ? base.outcome : 'failed', repeat: summary, ...(stable ? {} : { failurePhase: 'repeat' as const }) };
  return preflight === undefined ? combined : withSetupPreflight(combined, preflight);
}

function summarizeSetupPreflight(preflight: SetupPreflightEnvironment): string {
  if (preflight.status === 'passed') return `passed (setup ran twice; ${preflight.statePaths.join(', ')} unchanged in ${preflight.durationMs}ms)`;
  const changes = [
    ...preflight.added.map(item => `added ${item}`),
    ...preflight.removed.map(item => `removed ${item}`),
    ...preflight.changed.map(item => `changed ${item}`),
  ];
  const exits = `setup exits ${preflight.firstExitCode ?? 'none'} then ${preflight.secondExitCode ?? 'none'}`;
  return `failed (${changes.length ? `${changes.join(', ')}; ${exits}` : exits}; ${preflight.statePaths.join(', ')})`;
}

export function summarizeVerification(result: VerifyResult): string {
  const lines = [`Verification: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.total} declared).`];
  const readinessFailed = result.readiness !== undefined && !result.readiness.reached;
  if (readinessFailed && result.readiness) {
    const exit = result.readiness.exitCode === undefined ? '' : ` (exit ${result.readiness.exitCode ?? 'none'}${result.readiness.signal ? `, signal ${result.readiness.signal}` : ''})`;
    lines.push(`- primary cause: readiness ${result.readiness.url} was not reached after ${result.readiness.waitedMs}ms (${result.readiness.attempts} attempt(s))${exit}${result.readiness.error ? ` — ${result.readiness.error}` : ''}; check failures below may be environmental rather than application bugs.`);
  }
  if (result.repeat) {
    const repeat = result.repeat;
    const code = repeat.stable ? 'stable' : repeat.code ?? 'state_not_idempotent';
    const details = [
      ...(repeat.differing.length ? [`differing: ${repeat.differing.join(', ')}`] : []),
      ...(repeat.drifting?.length ? [`drifting: ${repeat.drifting.map(entry => entry.checkId).join(', ')}`] : []),
    ];
    lines.push(`- repeat: ${repeat.attempts} attempts, ${code}${details.length ? ` (${details.join('; ')})` : ''}`);
    for (const drift of repeat.drifting ?? []) lines.push(`- repeat drift (${drift.checkId}): ${drift.observations.join(' → ')}`);
    if (repeat.readiness && repeat.readiness.observations.length && (!repeat.readiness.stable || repeat.readiness.observations.some(observation => !observation.reached))) {
      lines.push(`- repeat readiness: ${repeat.readiness.observations.map(describeReadinessObservation).join(' → ')}`);
    }
    for (const hint of repeat.hints ?? []) lines.push(`- repeat hint: ${hint}`);
    if (repeat.stable) {
      for (const check of repeat.outcomes[0]?.checks ?? []) {
        if (check.observation) lines.push(`- repeat observation (${check.id}): ${check.observation} (identical across ${repeat.attempts} attempts)`);
      }
    }
  }
  for (const check of result.results) {
    const detail = check.status === 'skipped'
      ? check.stderr || 'not runnable'
      : check.kind === 'http'
        ? `HTTP ${check.observedStatus ?? 'none'} (expected ${check.expectedStatus ?? 200}) in ${check.durationMs}ms${check.timedOut ? ' (timed out)' : ''}${check.declaredKind === 'browser' ? ' [legacy browser alias]' : ''}`
        : check.kind === 'ui'
          ? `rendered "${check.rendered?.title ?? ''}" in ${check.durationMs}ms (${check.rendered?.screenshotBytes ?? 0} B screenshot, ${check.rendered?.domBytes ?? 0} B DOM)${check.rendered?.wait.waitFor ? ` after ${check.rendered.wait.waitFor}` : ''}`
          : `exit ${check.exitCode ?? 'none'} in ${check.durationMs}ms${check.timedOut ? ' (timed out)' : ''}`;
    const assertionFailures = (check.assertions ?? []).filter(assertion => !assertion.passed).map(describeAssertionFailure);
    const cause = readinessFailed && check.status === 'failed' && (check.kind === 'ui' || check.kind === 'http') ? '; readiness was not reached before this check ran' : '';
    lines.push(`- ${check.id} [${check.kind}]: ${check.status} (${detail})${assertionFailures.length ? ` — ${assertionFailures.join(' ')}` : ''}${cause}`);
    for (const hint of check.hints ?? []) lines.push(`  hint (${check.id}): ${hint}`);
  }
  if (result.readiness) {
    const exit = result.readiness.exitCode === undefined ? '' : ` (exit ${result.readiness.exitCode ?? 'none'}${result.readiness.signal ? `, signal ${result.readiness.signal}` : ''})`;
    lines.push(`- readiness ${result.readiness.url}: ${result.readiness.reached ? 'reached' : 'not reached'} after ${result.readiness.waitedMs}ms (${result.readiness.attempts} attempt(s))${exit}${result.readiness.error ? ` — ${result.readiness.error}` : ''}`);
  }
  if (result.setup) lines.push(`- setup: ${result.setup.status} (exit ${result.setup.exitCode ?? 'none'}, ${result.setup.durationMs}ms)`);
  if (result.setupPreflight) lines.push(`- setup preflight: ${summarizeSetupPreflight(result.setupPreflight)}`);
  if (result.setupSkippedReason) lines.push(`- setup: skipped (${result.setupSkippedReason})`);
  if (result.teardown) lines.push(`- teardown: ${result.teardown.status} (exit ${result.teardown.exitCode ?? 'none'}, ${result.teardown.durationMs}ms)`);
  if (result.commandIsolation?.length) lines.push(`- command isolation: withheld ${result.commandIsolation.join(', ')} from command checks`);
  if (result.serve) {
    const shutdown = result.serve.shutdown;
    const shutdownDetail = shutdown
      ? `; ${shutdown.reason}${shutdown.expected ? ' (expected)' : ' (unexpected)'}${shutdown.forced ? ', forced' : ''}${shutdown.durationMs === undefined ? '' : ` after ${shutdown.durationMs}ms`}${shutdown.exitCode === undefined ? '' : `, exit ${shutdown.exitCode ?? 'none'}`}`
      : result.serve.stopped ? '; stopped' : result.serve.keepRunning ? '; left running' : '';
    const ownership = result.serve.ownership === 'reused' ? 'reused an external server (explicit)' : result.serve.startedBy === 'setup' ? 'listener started by setup' : result.serve.started ? 'started' : 'not started';
    lines.push(`- serve: ${ownership}${result.serve.port === undefined ? '' : ` on port ${result.serve.port}`}${shutdownDetail}${result.serve.error ? ` — ${result.serve.error}` : ''}`);
  }
  return lines.join('\n');
}

/** Persist bounded verification output beside the change so close and archive carry it. */
export async function persistVerificationLog(root: string, result: VerifyResult): Promise<{ logPath: string; logHash: string; logBytes: number }> {
  const changeDirectory = path.join(path.resolve(root), '.notchlet', 'changes', result.changeId);
  const directory = path.join(changeDirectory, 'evidence', 'logs');
  const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
  const payload = {
    schemaVersion: 2,
    changeId: result.changeId,
    capturedAt: new Date().toISOString(),
    outcome: result.outcome,
    ...(result.failurePhase === undefined ? {} : { failurePhase: result.failurePhase }),
    ...(result.blocked === undefined ? {} : { blocked: result.blocked }),
    summary: summarizeVerification(result),
    ...(result.readiness === undefined ? {} : { readiness: result.readiness }),
    ...(result.serve === undefined ? {} : { serve: result.serve }),
    ...(result.setup === undefined ? {} : { setup: result.setup }),
    ...(result.setupPreflight === undefined ? {} : { setupPreflight: result.setupPreflight }),
    ...(result.setupSkippedReason === undefined ? {} : { setupSkippedReason: result.setupSkippedReason }),
    ...(result.teardown === undefined ? {} : { teardown: result.teardown }),
    ...(result.commandIsolation === undefined ? {} : { commandIsolation: result.commandIsolation }),
    ...(result.repeat === undefined ? {} : { repeat: result.repeat }),
    environment: result.environment,
    checks: result.results.map(check => ({
      id: check.id, description: check.description, kind: check.kind, declaredKind: check.declaredKind,
      command: check.command, url: check.url, workingDirectory: check.workingDirectory,
      expectedStatus: check.expectedStatus, expectedBodyContains: check.expectedBodyContains, expectedJson: check.expectedJson,
      expectedJsonContains: check.expectedJsonContains, expectedJsonAt: check.expectedJsonAt, expectedHeaders: check.expectedHeaders,
      waitFor: check.waitFor, settleMs: check.settleMs, expectedSelectors: check.expectedSelectors, expectedText: check.expectedText,
      expectedTitle: check.expectedTitle, expectedVisibleSelectors: check.expectedVisibleSelectors, expectedEnabledSelectors: check.expectedEnabledSelectors,
      expectedScopedText: check.expectedScopedText, steps: check.steps, captureArtifacts: check.captureArtifacts, environment: check.environment,
      expectedNoConsoleErrors: check.expectedNoConsoleErrors, fullPage: check.fullPage, capture: check.capture,
      observedStatus: check.observedStatus, assertions: check.assertions, rendered: check.rendered, status: check.status,
      exitCode: check.exitCode, signal: check.signal, timedOut: check.timedOut, durationMs: check.durationMs,
      stdout: check.stdout, stderr: check.stderr, hints: check.hints, blockedBy: check.blockedBy,
    })),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(file, text, { flag: 'wx' });
  return {
    logPath: ['evidence', 'logs', path.basename(file)].join('/'),
    logHash: createHash('sha256').update(text).digest('hex'),
    logBytes: Buffer.byteLength(text, 'utf8'),
  };
}
