import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowError, type ScopedTextExpectation, type UiStep } from '@notchlet/core';

export interface CaptureConsoleMessage { type: string; text: string; url?: string; source?: string; lineNumber?: number }
export interface CaptureStepResult { index: number; action: string; ok: boolean; detail: string }
export interface CaptureResult {
  url: string;
  browser: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  title: string;
  text: string;
  fullPage: boolean;
  selectors: Record<string, boolean>;
  visible: Record<string, boolean>;
  hidden: Record<string, boolean>;
  hiddenPresent: Record<string, boolean>;
  absent: Record<string, boolean>;
  enabled: Record<string, boolean>;
  scopedText: Record<string, string | null>;
  steps: CaptureStepResult[];
  wait: { settleMs: number; waitFor?: string; waitedMs: number; matched: boolean };
  console: { messages: CaptureConsoleMessage[]; errors: string[] };
  screenshot: { path: string; bytes: number };
  dom: { path: string; bytes: number };
  cleanup: () => Promise<void>;
}

export interface CaptureOptions {
  url: string;
  browser?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  waitFor?: string;
  settleMs?: number;
  fullPage?: boolean;
  selectors?: string[];
  visibleSelectors?: string[];
  hiddenSelectors?: string[];
  absentSelectors?: string[];
  enabledSelectors?: string[];
  scopedText?: ScopedTextExpectation[];
  steps?: UiStep[];
  stepTimeoutMs?: number;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 250;

function candidateBrowsers(): Array<{ path: string; label: string }> {
  const env = process.env;
  const programFiles = env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA ?? '';
  const candidates: Array<{ path: string; label: string }> = [];
  const add = (file: string | undefined, label: string) => { if (file) candidates.push({ path: file, label }); };
  if (env.NOTCHLET_BROWSER?.trim()) add(env.NOTCHLET_BROWSER.trim(), 'NOTCHLET_BROWSER');
  if (env.CHROME_PATH?.trim()) add(env.CHROME_PATH.trim(), 'CHROME_PATH');
  if (process.platform === 'win32') {
    add(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome');
    add(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome');
    add(localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined, 'chrome');
    add(path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'msedge');
    add(path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'msedge');
  } else if (process.platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'msedge');
    add('/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium');
  } else {
    add('/usr/bin/google-chrome', 'chrome');
    add('/usr/bin/chromium', 'chromium');
    add('/usr/bin/chromium-browser', 'chromium');
    add('/usr/bin/microsoft-edge', 'msedge');
  }
  for (const name of ['chrome', 'chromium', 'chromium-browser', 'msedge', 'google-chrome']) candidates.push({ path: name, label: name });
  return candidates;
}

async function executableExists(candidate: string): Promise<boolean> {
  if (path.isAbsolute(candidate)) { try { await access(candidate); return true; } catch { return false; } }
  return new Promise(resolve => {
    const probe = process.platform === 'win32' ? spawn('where', [candidate], { windowsHide: true, stdio: 'ignore' }) : spawn('which', [candidate], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', code => resolve(code === 0));
  });
}

export async function resolveBrowser(explicit?: string): Promise<{ path: string; label: string }> {
  if (explicit?.trim()) {
    if (await executableExists(explicit.trim())) return { path: explicit.trim(), label: path.basename(explicit.trim()) };
    throw new WorkflowError('browser_not_found', `Browser executable not found: ${explicit}.`, 'Provide a valid Chrome/Edge/Chromium executable path or omit --browser to auto-detect.');
  }
  for (const candidate of candidateBrowsers()) if (await executableExists(candidate.path)) return candidate;
  throw new WorkflowError('browser_not_found', 'No Chrome, Edge, or Chromium executable was found for browser capture.', 'Install a Chromium browser, set CHROME_PATH, or pass --browser <executable>.');
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    throw new WorkflowError('invalid_capture_url', `Capture URL is not valid: ${url}`, 'Provide an absolute http(s) URL of the running app.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new WorkflowError('invalid_capture_url', `Capture URL must use http or https: ${url}`, 'Provide an absolute http(s) URL of the running app.');
}

type CdpEvent = { method: string; params?: Record<string, unknown>; sessionId?: string };
type CdpResponse = { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };

class CdpConnection {
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => this.onMessage(String(event.data)));
    socket.addEventListener('close', () => this.close(new Error('Browser DevTools connection closed.')));
    socket.addEventListener('error', () => this.close(new Error('Browser DevTools connection failed.')));
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out connecting to the browser DevTools endpoint.')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to the browser DevTools endpoint.')); });
    });
    return new CdpConnection(socket);
  }

  private onMessage(raw: string): void {
    let message: CdpResponse;
    try { message = JSON.parse(raw) as CdpResponse; } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Browser DevTools command failed.'));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      const event = { method: message.method, ...(message.params === undefined ? {} : { params: message.params }), ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }) };
      for (const listener of [...this.listeners]) listener(event);
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('Browser DevTools connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser DevTools command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  once(method: string, sessionId: string, timeoutMs: number): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error(`Timed out waiting for browser event ${method}.`)); }, timeoutMs);
      const listener = (event: CdpEvent) => {
        if (event.method !== method || (event.sessionId !== undefined && event.sessionId !== sessionId)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(event);
      };
      this.listeners.add(listener);
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error('Browser DevTools connection closed.'));
    }
    this.pending.clear();
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function launchBrowser(executable: string, profilePath: string, timeoutMs: number): Promise<{ child: ChildProcess; wsUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      `--user-data-dir=${profilePath}`,
      'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, wsUrl?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve({ child, wsUrl: wsUrl! });
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the browser debugging endpoint.')), timeoutMs);
    child.on('error', error => finish(error));
    child.on('close', code => finish(new Error(`Browser exited before capture (exit ${code ?? 'none'}).${stderr ? ` ${stderr.trim().slice(-500)}` : ''}`)));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384);
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) finish(undefined, match[1]);
    });
  });
}

async function stopBrowser(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 1_500);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
  if (child.exitCode !== null || process.platform !== 'win32' || child.pid === undefined) return;
  await new Promise<void>(resolve => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => resolve());
    killer.on('close', () => resolve());
  });
}

async function evaluate(connection: CdpConnection, sessionId: string, expression: string, timeoutMs: number): Promise<unknown> {
  const response = await connection.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId, timeoutMs);
  const result = response.result as { value?: unknown } | undefined;
  return result?.value;
}

function consoleLocation(message: CaptureConsoleMessage): string {
  if (message.url) return `${message.url}${message.lineNumber === undefined ? '' : `:${message.lineNumber}`}`;
  if (message.source) return message.source;
  return '';
}

export function describeConsoleMessage(message: CaptureConsoleMessage): string {
  const location = consoleLocation(message);
  return location ? `[${location}] ${message.text}` : message.text;
}

const VISIBILITY_EXPRESSION = (selector: string): string => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
  for (let node = element; node; node = node.parentElement) {
    const computed = getComputedStyle(node);
    if (computed.display === 'none' || computed.visibility === 'hidden') return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
})()`;

const ENABLED_EXPRESSION = (selector: string): string => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  if ('disabled' in element && element.disabled === true) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  return element.matches(':disabled') !== true;
})()`;

const SCOPED_TEXT_EXPRESSION = (selector: string): string => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  return element ? (element.innerText || '').trim() : null;
})()`;

const SELECTOR_STATE_EXPRESSION = (selector: string): string => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return { exists: false, visible: false, reason: 'missing', text: '' };
  const style = getComputedStyle(element);
  let reason = '';
  if (style.display === 'none') reason = 'display:none';
  else if (style.visibility === 'hidden' || style.visibility === 'collapse') reason = 'visibility:' + style.visibility;
  else if (Number(style.opacity) === 0) reason = 'opacity:0';
  if (!reason) {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const computed = getComputedStyle(node);
      if (computed.display === 'none') { reason = 'ancestor display:none'; break; }
      if (computed.visibility === 'hidden' || computed.visibility === 'collapse') { reason = 'ancestor visibility:' + computed.visibility; break; }
    }
  }
  const rect = element.getBoundingClientRect();
  if (!reason && (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0)) reason = 'zero size';
  return {
    exists: true,
    visible: !reason,
    reason,
    display: style.display,
    visibility: style.visibility,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    text: (element.innerText || '').trim()
  };
})()`;

const PAGE_TEXT_STATE_EXPRESSION = (selector: string | undefined, text: string): string => `(() => {
  const selector = ${selector === undefined ? 'null' : JSON.stringify(selector)};
  const expected = ${JSON.stringify(text)};
  if (selector === null) {
    const body = document.body ? (document.body.innerText || '') : '';
    return { ok: body.includes(expected), where: 'page', text: body, missingBody: !document.body };
  }
  const element = document.querySelector(selector);
  if (!element) return { ok: false, where: 'element', state: 'missing', text: '' };
  const style = getComputedStyle(element);
  let hidden = style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0;
  if (!hidden) for (let node = element.parentElement; node; node = node.parentElement) {
    const computed = getComputedStyle(node);
    if (computed.display === 'none' || computed.visibility === 'hidden' || computed.visibility === 'collapse') { hidden = true; break; }
  }
  const rendered = (element.innerText || '').trim();
  return { ok: !hidden && rendered.includes(expected), where: 'element', state: hidden ? 'hidden' : (rendered ? 'visible' : 'empty'), text: rendered };
})()`;

export function describeTextState(state: { ok?: boolean; where?: string; state?: string; text?: string; missingBody?: boolean } | undefined, expected: string, selector?: string): string {
  const scope = selector === undefined ? 'page' : `element ${selector}`;
  if (!state) return `could not read ${scope}`;
  if (state.missingBody) return 'document body is not available';
  if (state.where === 'element' && state.state === 'missing') return `selector ${selector} is missing`;
  if (state.where === 'element' && state.state === 'hidden') return `selector ${selector} is present but hidden`;
  if (state.where === 'element' && state.state === 'empty') return `selector ${selector} is present but empty`;
  if (state.ok) return `text ${JSON.stringify(expected)} present in ${scope}`;
  const rendered = (state.text ?? '').replace(/\s+/g, ' ').trim();
  return rendered
    ? `text absent from ${scope}: expected ${JSON.stringify(expected)} (rendered: ${JSON.stringify(rendered.slice(0, 160))}${rendered.length > 160 ? '…' : ''})`
    : `text absent from ${scope}: expected ${JSON.stringify(expected)} (no rendered text)`;
}

async function waitForSelector(connection: CdpConnection, sessionId: string, selector: string, deadline: number, timeoutMs: number): Promise<boolean> {
  const end = Math.min(deadline, Date.now() + timeoutMs);
  while (true) {
    const found = await evaluate(connection, sessionId, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, Math.max(1, end - Date.now())).catch(() => false) === true;
    if (found) return true;
    if (Date.now() >= end) return false;
    await sleep(Math.min(50, Math.max(1, end - Date.now())));
  }
}

async function waitForVisible(connection: CdpConnection, sessionId: string, selector: string, deadline: number, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const end = Math.min(deadline, Date.now() + timeoutMs);
  let state: { exists?: boolean; visible?: boolean; reason?: string } | undefined;
  let lastError = '';
  while (true) {
    const budget = Math.max(1, end - Date.now());
    state = await evaluate(connection, sessionId, SELECTOR_STATE_EXPRESSION(selector), budget).catch((error: unknown) => { lastError = error instanceof Error ? error.message : String(error); return state; }) as typeof state;
    if (state?.visible) return { ok: true, detail: `selector ${selector} visible` };
    if (Date.now() >= end) break;
    await sleep(Math.min(50, Math.max(1, end - Date.now())));
  }
  if (!state?.exists) return { ok: false, detail: `selector ${selector} is missing${lastError ? ` (${lastError})` : ''}` };
  return { ok: false, detail: `selector ${selector} is present but hidden (${state.reason || 'not visible'})` };
}

async function waitForText(connection: CdpConnection, sessionId: string, selector: string | undefined, text: string, deadline: number, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const end = Math.min(deadline, Date.now() + timeoutMs);
  const expression = PAGE_TEXT_STATE_EXPRESSION(selector, text);
  let state: Parameters<typeof describeTextState>[0];
  while (true) {
    state = await evaluate(connection, sessionId, expression, Math.max(1, end - Date.now())).catch(() => state) as typeof state;
    if (state?.ok) return { ok: true, detail: describeTextState(state, text, selector) };
    if (Date.now() >= end) break;
    await sleep(Math.min(50, Math.max(1, end - Date.now())));
  }
  return { ok: false, detail: describeTextState(state, text, selector) };
}

function stepExpression(step: UiStep): string {
  const selector = step.selector === undefined ? 'null' : JSON.stringify(step.selector);
  if (step.action === 'fill' || step.action === 'select') {
    return `(() => {
      const element = document.querySelector(${selector});
      if (!element) return { ok: false, detail: 'selector not found' };
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, ${JSON.stringify(step.value ?? '')}); else element.value = ${JSON.stringify(step.value ?? '')};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: '${step.action === 'fill' ? 'filled' : 'selected'}' };
    })()`;
  }
  if (step.action === 'click') {
    return `(() => {
      const element = document.querySelector(${selector});
      if (!element) return { ok: false, detail: 'selector not found' };
      if ('disabled' in element && element.disabled === true) return { ok: false, detail: 'element is disabled' };
      if (element.getAttribute('aria-disabled') === 'true') return { ok: false, detail: 'element is aria-disabled' };
      element.scrollIntoView({ block: 'center' });
      element.click();
      return { ok: true, detail: 'clicked' };
    })()`;
  }
  if (step.action === 'press') {
    return `(() => {
      const element = document.querySelector(${selector});
      if (!element) return { ok: false, detail: 'selector not found' };
      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(step.key ?? '')}, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(step.key ?? '')}, bubbles: true }));
      return { ok: true, detail: 'pressed ${String(step.key ?? '').replace(/'/g, "\\'")}' };
    })()`;
  }
  if (step.action === 'assertText') {
    return PAGE_TEXT_STATE_EXPRESSION(step.selector, step.text ?? '');
  }
  if (step.action === 'assertUrl') {
    return `(() => {
      const href = location.href;
      return { ok: href.includes(${JSON.stringify(step.contains ?? '')}), detail: href };
    })()`;
  }
  return '({ ok: false, detail: "unsupported step" })';
}

async function runSteps(connection: CdpConnection, sessionId: string, steps: UiStep[], deadline: number, stepTimeoutMs: number): Promise<CaptureStepResult[]> {
  const results: CaptureStepResult[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.action === 'settle') {
      const ms = Math.max(0, step.ms ?? 0);
      await sleep(Math.min(ms, Math.max(1, deadline - Date.now())));
      results.push({ index, action: step.action, ok: true, detail: `settled ${ms}ms` });
      continue;
    }
    if (step.action === 'waitFor') {
      const matched = await waitForSelector(connection, sessionId, step.selector ?? '', deadline, step.timeoutMs ?? stepTimeoutMs);
      results.push({ index, action: step.action, ok: matched, detail: matched ? 'selector present (presence only)' : `selector ${step.selector} did not appear` });
      if (!matched) break;
      continue;
    }
    if (step.action === 'waitForVisible' || step.action === 'waitForText') {
      const budget = step.timeoutMs ?? stepTimeoutMs;
      const outcome = step.action === 'waitForVisible'
        ? await waitForVisible(connection, sessionId, step.selector ?? '', deadline, budget)
        : await waitForText(connection, sessionId, step.selector, step.text ?? '', deadline, budget);
      results.push({ index, action: step.action, ok: outcome.ok, detail: outcome.detail });
      if (!outcome.ok) break;
      continue;
    }
    if (step.action === 'assertText' && step.timeoutMs !== undefined) {
      const outcome = await waitForText(connection, sessionId, step.selector, step.text ?? '', deadline, step.timeoutMs);
      results.push({ index, action: step.action, ok: outcome.ok, detail: outcome.detail });
      if (!outcome.ok) break;
      continue;
    }
    try {
      const value = await evaluate(connection, sessionId, stepExpression(step), Math.max(1, Math.min(deadline - Date.now(), stepTimeoutMs))) as { ok?: boolean; detail?: string; where?: string; state?: string; text?: string; missingBody?: boolean } | undefined;
      const ok = value?.ok === true;
      const detail = step.action === 'assertText'
        ? describeTextState(value, step.text ?? '', step.selector)
        : String(value?.detail ?? (ok ? 'completed' : 'step failed'));
      results.push({ index, action: step.action, ok, detail });
      if (!ok) break;
    } catch (error) {
      results.push({ index, action: step.action, ok: false, detail: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return results;
}

/** Capture a headless screenshot and DOM snapshot from one rendered browser session with provenance. */
export async function capturePage(options: CaptureOptions): Promise<CaptureResult> {
  assertHttpUrl(options.url);
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 1 || viewport.height < 1) {
    throw new WorkflowError('invalid_capture_viewport', 'Capture viewport must be positive integers.', 'Provide --viewport 1280x900.');
  }
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  if (!Number.isInteger(settleMs) || settleMs < 0) throw new WorkflowError('invalid_capture_settle', 'Capture settle time must be a non-negative integer.', 'Provide --settle-ms 500.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const browser = await resolveBrowser(options.browser);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'notchlet-capture-'));
  const screenshotPath = path.join(directory, 'capture.png');
  const domPath = path.join(directory, 'capture.html');
  const profilePath = path.join(directory, 'profile');
  let child: ChildProcess | undefined;
  let connection: CdpConnection | undefined;
  try {
    const launched = await launchBrowser(browser.path, profilePath, remaining());
    child = launched.child;
    connection = await CdpConnection.connect(launched.wsUrl, remaining());
    const target = await connection.send('Target.createTarget', { url: 'about:blank' }, undefined, remaining());
    const targetId = String(target.targetId);
    const attached = await connection.send('Target.attachToTarget', { targetId, flatten: true }, undefined, remaining());
    const sessionId = String(attached.sessionId);
    const messages: CaptureConsoleMessage[] = [];
    const errors: string[] = [];
    const pushConsole = (message: CaptureConsoleMessage) => {
      messages.push(message);
      if (message.type === 'error' || message.type === 'assert' || message.type === 'exception') errors.push(describeConsoleMessage(message));
    };
    const frameLocation = (frame: Record<string, unknown> | undefined): Pick<CaptureConsoleMessage, 'url' | 'lineNumber'> => ({
      ...(typeof frame?.url === 'string' && frame.url ? { url: frame.url } : {}),
      ...(typeof frame?.lineNumber === 'number' ? { lineNumber: frame.lineNumber + 1 } : {}),
    });
    connection.onEvent(event => {
      if (event.sessionId !== sessionId) return;
      if (event.method === 'Runtime.consoleAPICalled') {
        const params = event.params ?? {};
        const args = Array.isArray(params.args) ? params.args as Array<Record<string, unknown>> : [];
        const stack = (params.stackTrace ?? {}) as Record<string, unknown>;
        const frame = Array.isArray(stack.callFrames) ? (stack.callFrames[0] as Record<string, unknown> | undefined) : undefined;
        pushConsole({ type: String(params.type ?? 'log'), text: args.map(arg => String(arg.value ?? arg.description ?? '')).join(' '), ...frameLocation(frame) });
      } else if (event.method === 'Runtime.exceptionThrown') {
        const details = (event.params?.exceptionDetails ?? {}) as Record<string, unknown>;
        const exception = (details.exception ?? {}) as Record<string, unknown>;
        const stack = (details.stackTrace ?? {}) as Record<string, unknown>;
        const frame = Array.isArray(stack.callFrames) ? (stack.callFrames[0] as Record<string, unknown> | undefined) : undefined;
        pushConsole({
          type: 'exception',
          text: String(exception.description ?? details.text ?? 'Uncaught exception'),
          ...(typeof details.url === 'string' ? { url: details.url } : {}),
          ...(typeof details.lineNumber === 'number' ? { lineNumber: details.lineNumber + 1 } : {}),
          ...frameLocation(frame),
        });
      } else if (event.method === 'Log.entryAdded') {
        const entry = (event.params?.entry ?? {}) as Record<string, unknown>;
        if (String(entry.level ?? '') !== 'error') return;
        pushConsole({
          type: 'error',
          text: String(entry.text ?? 'Browser log error'),
          ...(typeof entry.url === 'string' && entry.url ? { url: entry.url } : {}),
          ...(typeof entry.source === 'string' && entry.source ? { source: entry.source } : {}),
          ...(typeof entry.lineNumber === 'number' ? { lineNumber: entry.lineNumber + 1 } : {}),
        });
      }
    });
    await connection.send('Page.enable', {}, sessionId, remaining());
    await connection.send('Runtime.enable', {}, sessionId, remaining());
    await connection.send('Log.enable', {}, sessionId, remaining());
    await connection.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId, remaining());
    const loaded = connection.once('Page.loadEventFired', sessionId, remaining());
    loaded.catch(() => undefined);
    await connection.send('Page.navigate', { url: options.url }, sessionId, remaining());
    await loaded;
    const navigationFinished = Date.now();
    await evaluate(connection, sessionId, 'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true', remaining()).catch(() => undefined);
    let matched = false;
    if (options.waitFor) {
      while (Date.now() < deadline) {
        matched = await evaluate(connection, sessionId, `Boolean(document.querySelector(${JSON.stringify(options.waitFor)}))`, remaining()).catch(() => false) === true;
        if (matched) break;
        await sleep(100);
      }
      if (!matched) throw new WorkflowError('browser_capture_failed', `Timed out waiting for selector "${options.waitFor}".`, 'Confirm the selector matches after the app hydrates, or increase --capture-timeout.');
    }
    const steps = options.steps?.length ? await runSteps(connection, sessionId, options.steps, deadline, options.stepTimeoutMs ?? 5_000) : [];
    await sleep(Math.min(settleMs, remaining()));
    const fullPage = options.fullPage === true;
    let clip: Record<string, unknown> | undefined;
    if (fullPage) {
      const metrics = await connection.send('Page.getLayoutMetrics', {}, sessionId, remaining());
      const size = (metrics.cssContentSize ?? metrics.contentSize ?? {}) as Record<string, unknown>;
      if (typeof size.width === 'number' && typeof size.height === 'number') clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    }
    const shot = await connection.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, sessionId, remaining());
    await writeFile(screenshotPath, Buffer.from(String(shot.data), 'base64'));
    const domText = String(await evaluate(connection, sessionId, 'document.documentElement ? document.documentElement.outerHTML : ""', remaining()) ?? '');
    if (!domText.trim()) throw new WorkflowError('browser_capture_failed', 'Browser DOM capture was empty.', 'Check that the URL renders HTML and try again.');
    const text = String(await evaluate(connection, sessionId, 'document.body ? document.body.innerText : ""', remaining()) ?? '');
    const title = String(await evaluate(connection, sessionId, 'document.title', remaining()) ?? '');
    const selectors: Record<string, boolean> = {};
    for (const selector of options.selectors ?? []) {
      selectors[selector] = await evaluate(connection, sessionId, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, remaining()).catch(() => false) === true;
    }
    const visible: Record<string, boolean> = {};
    for (const selector of options.visibleSelectors ?? []) {
      visible[selector] = await evaluate(connection, sessionId, VISIBILITY_EXPRESSION(selector), remaining()).catch(() => false) === true;
    }
    const hidden: Record<string, boolean> = {};
    const hiddenPresent: Record<string, boolean> = {};
    for (const selector of options.hiddenSelectors ?? []) {
      hiddenPresent[selector] = await evaluate(connection, sessionId, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, remaining()).catch(() => false) === true;
      hidden[selector] = await evaluate(connection, sessionId, VISIBILITY_EXPRESSION(selector), remaining()).then(value => value !== true).catch(() => false);
    }
    const absent: Record<string, boolean> = {};
    for (const selector of options.absentSelectors ?? []) {
      absent[selector] = await evaluate(connection, sessionId, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, remaining()).then(value => value !== true).catch(() => false);
    }
    const enabled: Record<string, boolean> = {};
    for (const selector of options.enabledSelectors ?? []) {
      enabled[selector] = await evaluate(connection, sessionId, ENABLED_EXPRESSION(selector), remaining()).catch(() => false) === true;
    }
    const scopedText: Record<string, string | null> = {};
    for (const expectation of options.scopedText ?? []) {
      const value = await evaluate(connection, sessionId, SCOPED_TEXT_EXPRESSION(expectation.selector), remaining()).catch(() => null);
      scopedText[expectation.selector] = typeof value === 'string' ? value : null;
    }
    await writeFile(domPath, domText);
    const screenshotBytes = await readFile(screenshotPath);
    if (screenshotBytes.byteLength === 0) throw new WorkflowError('browser_capture_failed', 'Browser produced an empty screenshot.', 'Check that the URL renders content and try again.');
    const capturedAt = new Date().toISOString();
    return {
      url: options.url,
      browser: browser.label,
      capturedAt,
      viewport,
      title,
      text,
      fullPage,
      selectors,
      visible,
      hidden,
      hiddenPresent,
      absent,
      enabled,
      scopedText,
      steps,
      wait: { settleMs, ...(options.waitFor === undefined ? {} : { waitFor: options.waitFor }), waitedMs: Date.now() - navigationFinished, matched },
      console: { messages, errors },
      screenshot: { path: screenshotPath, bytes: screenshotBytes.byteLength },
      dom: { path: domPath, bytes: Buffer.byteLength(domText, 'utf8') },
      // Windows keeps Chromium profile locks briefly after exit; retry instead of failing the check.
      cleanup: async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined); },
    };
  } catch (error) {
    if (connection) { await connection.send('Browser.close').catch(() => undefined); connection.close(); }
    if (child) await stopBrowser(child);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError('browser_capture_failed', error instanceof Error ? error.message : String(error), 'Check that the URL is reachable and the browser can start headlessly.');
  } finally {
    connection?.close();
    if (child) await stopBrowser(child);
  }
}
