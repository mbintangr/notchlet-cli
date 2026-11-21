#!/usr/bin/env node
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { addCheckToChange, addDesignDecisionToChange, addRequirementToChange, addScenarioToChange, addTaskToChange, appendEvidence, applyChangeUpdate, artifactRole, authorCapabilityDeltaOperation, authorCapabilityDeltaOperations, capabilityContribution, captureCapabilityBaseline, CORE_VERSION, closeChange, completeTasks, coverageEvidenceFrom, coverageReport, deleteCapabilityDeltaOperation, diagnoseArtifactLocations, evaluateEvidenceFreshness, evaluateState, evaluateVerificationFacets, evidenceAssetPath, findWorkspace, importChangePlan, initWorkspace, inspectChangeArtifacts, inspectEvidence, inspectExecutionDrift, inspectPlan, instructions, listArchivedChanges, listChanges, listSchemas, mutateChange, parseChangeOperations, parseChangePlan, persistChangeOperations, persistConversion, presenceOnlyUiChecks, previewCapabilityClose, previewPlanReadiness, projectChangePlan, readArchivedChange, readChange, readEvidence, readSchema, readiness, removeChangeItem, renderChangeArtifacts, resolveEvidenceScope, restoreChange, scaffold, schemaDirectory, seedCapabilityDeltaOperations, setupAdvisory, stageEvidenceAttachments, taskEvidenceStatus, transitionTask, updateChangeItem, verificationRecovery, withMarkdownArtifacts, WorkflowError, writeChangeArtifacts, type ChangeCollection, type ChangeItemKind, type ChangeItemPatch, type EvidenceCapture, type EvidenceWriteInput, type JsonPathAssertion, type TaskStatus, type WorkflowAction, type CliJsonEnvelope } from '@notchlet/core';
import { section, kv, bullet, ok, err, warn, table, box, divider } from './cli-format.js';
import { isTty, prompt, secret, confirm, requiredString } from './cli-prompt.js';
import { readAttemptHistory, summarizeHistory } from './history.js';

const args = process.argv.slice(2);
const profiling = process.env.NOTCHLET_PROFILE === '1';
const profileTimings: Record<string, number> = {};
const profileNow = () => Number(process.hrtime.bigint()) / 1e6;
function profileSync<T>(name: string, operation: () => T): T {
  if (!profiling) return operation();
  const start = profileNow();
  try { return operation(); }
  finally { profileTimings[name] = (profileTimings[name] ?? 0) + profileNow() - start; }
}
async function profileAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!profiling) return operation();
  const start = profileNow();
  try { return await operation(); }
  finally { profileTimings[name] = (profileTimings[name] ?? 0) + profileNow() - start; }
}
const json = args.includes('--json');
// Boolean switches never consume a following token. Every other `--flag` is treated as
// taking a value, so new commands work without maintaining a flag allowlist.
const booleanFlags = new Set(['--json', '--help', '-h', '--version', '--local', '--interactive', '--quick', '--preview', '--yes', '--revoke', '--apply', '--allow-file-token-store', '--keep-local', '--force', '--record', '--remote', '--offline', '--stale', '--failed', '--require-evidence', '--dry-run', '--render', '--no-render', '--markdown', '--full-page', '--expect-no-console-errors', '--all', '--all-missing', '--serve', '--keep-running', '--reuse-serve', '--save-setup', '--check-setup-idempotence', '--accept-plan-drift', '--history']);
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--') && !arg.includes('=')) { if (!booleanFlags.has(arg)) i++; continue; }
  if (!arg.startsWith('-')) positional.push(arg);
}
const rootOption = args.find(arg => arg.startsWith('--workspace=') || arg.startsWith('--root='));
const explicitRoot = rootOption?.slice(rootOption.indexOf('=') + 1) ?? (args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : args.includes('--root') ? args[args.indexOf('--root') + 1] : undefined);
const workspace = () => findWorkspace(process.cwd(), explicitRoot);
const DEFAULT_SERVER = 'https://pg-api.mbintangr.com';
const optionValue = (name: string): string | undefined => { const eq = args.find(arg => arg.startsWith(`${name}=`)); return eq ? eq.slice(name.length + 1) : args.includes(name) ? args[args.indexOf(name) + 1] : undefined; };
const optionValues = (name: string): string[] => args.flatMap((arg, index) => {
  if (arg === name) return [args[index + 1]];
  if (arg.startsWith(`${name}=`)) return [arg.slice(name.length + 1)];
  return [];
}).filter((value): value is string => Boolean(value)).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
const rawOptionValues = (name: string): string[] => args.flatMap((arg, index) => {
  if (arg === name) return [args[index + 1]];
  if (arg.startsWith(`${name}=`)) return [arg.slice(name.length + 1)];
  return [];
}).filter((value): value is string => Boolean(value?.trim())).map(value => value.trim());
function jsonOption(name: string): unknown {
  const raw = rawOptionValues(name)[0] ?? optionValue(name);
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { fail('invalid_input', `${name} is not valid JSON.`, `Provide a valid JSON value for ${name}, or omit the flag.`, 2); }
}
function jsonPathAssertionsOption(): JsonPathAssertion[] | undefined {
  const raws = rawOptionValues('--expected-json-at');
  if (!raws.length) return undefined;
  const assertions: JsonPathAssertion[] = [];
  for (const raw of raws) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail('invalid_input', '--expected-json-at is not valid JSON.', 'Provide a JSON object or array of assertion objects, for example {"path":"$.items[0].stock","gte":1}.', 2); }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) fail('invalid_input', '--expected-json-at entries must be JSON objects.', 'Provide assertions such as {"path":"$.summary.total","gte":100}.', 2);
      assertions.push(record as JsonPathAssertion);
    }
  }
  return assertions;
}
function expectedHeadersOption(): Record<string, string> | undefined {
  const raws = rawOptionValues('--expected-header');
  if (!raws.length) return undefined;
  const headers: Record<string, string> = {};
  for (const raw of raws) {
    const separator = raw.indexOf(':');
    if (separator <= 0) fail('invalid_input', `Invalid --expected-header value: ${raw}`, 'Use the form "Name: value", for example "content-type: application/json".', 2);
    headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
  }
  return headers;
}
function environmentOption(): Record<string, string> | undefined {
  const raws = rawOptionValues('--environment');
  if (!raws.length) return undefined;
  const environment: Record<string, string> = {};
  for (const raw of raws) {
    const separator = raw.indexOf('=');
    if (separator <= 0) fail('invalid_input', `Invalid --environment value: ${raw}`, 'Use the form KEY=value, for example --environment API_MODE=test.', 2);
    environment[raw.slice(0, separator).trim()] = raw.slice(separator + 1);
  }
  return environment;
}
function viewportOption(): { width: number; height: number } | undefined {
  const raw = optionValue('--viewport');
  if (raw === undefined) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(raw);
  if (!match || Number(match[1]) < 1 || Number(match[2]) < 1) fail('usage_error', 'Provide --viewport as WIDTHxHEIGHT, for example 1280x900.', 'Use two positive integers separated by x.', 64);
  return { width: Number(match[1]), height: Number(match[2]) };
}
const serverOption = (): string => optionValue('--server') ?? DEFAULT_SERVER;
function parseRevisionOption(name: string): number | undefined {
  const raw = optionValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail('usage_error', usage, `Provide ${name} as a non-negative integer.`, 64);
  return value;
}
const CHANGE_KINDS: ChangeItemKind[] = ['requirement', 'check', 'scenario', 'decision', 'task'];
const AUTHORED_OPTIONS: Record<ChangeItemKind, string[]> = {
  requirement: ['--title', '--description'],
  check: ['--description', '--kind', '--command', '--url', '--expected-status', '--expected-body-contains', '--expected-json', '--expected-json-contains', '--expected-json-at', '--expected-header', '--wait-for', '--settle-ms', '--expected-selector', '--expected-text', '--expect-no-console-errors', '--full-page', '--working-directory', '--requirement', '--scenario', '--task'],
  scenario: ['--requirement', '--when', '--then'],
  decision: ['--decision', '--rationale'],
  task: ['--title', '--requirement', '--depends-on'],
};
const CHANGE_GLOBAL_OPTIONS = new Set(['--json', '--help', '-h', '--version', '--workspace', '--root']);
function isChangeKind(value: string | undefined): value is ChangeItemKind { return value !== undefined && (CHANGE_KINDS as string[]).includes(value); }
function assertOptions(allowed: string[], scope: string): void {
  for (const arg of args) {
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0];
    if (CHANGE_GLOBAL_OPTIONS.has(name)) continue;
    if (!allowed.includes(name)) fail('usage_error', `Unsupported option ${name} for ${scope}.`, `Use only documented options for ${scope}: ${allowed.join(', ') || '(none)'}.`, 64);
  }
}
function revisionOption(): { expectedRevision?: number } {
  const expected = parseRevisionOption('--revision');
  return expected === undefined ? {} : { expectedRevision: expected };
}
function itemPatchFromOptions(kind: ChangeItemKind): ChangeItemPatch {
  const patch: ChangeItemPatch = {};
  const single = (option: string, field: keyof ChangeItemPatch) => {
    const value = optionValue(option);
    if (value !== undefined) (patch as Record<string, unknown>)[field] = value;
  };
  if (kind === 'requirement') { single('--title', 'title'); single('--description', 'description'); }
  else if (kind === 'check') {
    single('--description', 'description'); single('--kind', 'kind'); single('--command', 'command'); single('--url', 'url');
    single('--expected-body-contains', 'expectedBodyContains');
    single('--wait-for', 'waitFor');
    single('--expected-text', 'expectedText');
    single('--working-directory', 'workingDirectory');
    const settleMs = optionValue('--settle-ms');
    if (settleMs !== undefined) {
      const value = Number(settleMs);
      if (!Number.isInteger(value) || value < 0) fail('invalid_input', '--settle-ms must be a non-negative integer.', 'Provide milliseconds such as --settle-ms 500.', 2);
      patch.settleMs = value;
    }
    const expectedSelectors = rawOptionValues('--expected-selector');
    if (expectedSelectors.length) patch.expectedSelectors = expectedSelectors;
    if (args.includes('--expect-no-console-errors')) patch.expectedNoConsoleErrors = true;
    if (args.includes('--full-page')) patch.fullPage = true;
    const expectedStatus = optionValue('--expected-status');
    if (expectedStatus !== undefined) (patch as Record<string, unknown>).expectedStatus = Number(expectedStatus);
    const expectedJson = optionValue('--expected-json');
    if (expectedJson !== undefined) {
      let parsed: unknown;
      try { parsed = JSON.parse(expectedJson); } catch { fail('invalid_input', '--expected-json is not valid JSON.', 'Provide a JSON object/array value or omit the flag.', 2); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_input', '--expected-json must be a JSON object.', 'Provide a JSON object such as {"status":"ok"}.', 2);
      (patch as Record<string, unknown>).expectedJson = parsed;
    }
    const expectedJsonContains = jsonOption('--expected-json-contains');
    if (expectedJsonContains !== undefined) (patch as Record<string, unknown>).expectedJsonContains = expectedJsonContains;
    const expectedJsonAt = jsonPathAssertionsOption();
    if (expectedJsonAt !== undefined) (patch as Record<string, unknown>).expectedJsonAt = expectedJsonAt;
    const expectedHeaders = expectedHeadersOption();
    if (expectedHeaders !== undefined) (patch as Record<string, unknown>).expectedHeaders = expectedHeaders;
    const requirementIds = optionValues('--requirement'); if (requirementIds.length) patch.requirementIds = requirementIds;
    const scenarioIds = optionValues('--scenario'); if (scenarioIds.length) patch.scenarioIds = scenarioIds;
    const taskIds = optionValues('--task'); if (taskIds.length) patch.taskIds = taskIds;
  } else if (kind === 'scenario') { single('--requirement', 'requirementId'); single('--when', 'when'); single('--then', 'then'); }
  else if (kind === 'decision') { single('--decision', 'decision'); single('--rationale', 'rationale'); }
  else {
    single('--title', 'title');
    const dependencies = optionValues('--depends-on'); if (dependencies.length) patch.dependencies = dependencies;
    const requirementIds = optionValues('--requirement'); if (requirementIds.length) patch.requirementIds = requirementIds;
  }
  return patch;
}
async function pickNamedValue<T>(input: string | undefined, items: T[], options: { kind: string; promptText: string; label: (item: T) => string; keys: (item: T) => string[] }): Promise<T | undefined> {
  const query = input?.trim().toLocaleLowerCase();
  let matches = items;
  if (query) {
    const exact = items.filter(item => options.keys(item).some(key => key.toLocaleLowerCase() === query));
    matches = exact.length ? exact : items.filter(item => options.keys(item).some(key => key.toLocaleLowerCase().includes(query)));
    if (!matches.length) {
      if (!isTty()) return undefined;
      matches = items;
    }
    if (matches.length === 1) return matches[0];
  } else if (!isTty()) return undefined;
  if (!isTty()) throw new Error(`${options.kind} name is ambiguous: ${matches.slice(0, 10).map(options.label).join('; ')}. Use a more specific name or ID.`);
  const choices = matches.slice(0, 20);
  process.stderr.write(`${options.kind} choices:\n${choices.map((item, index) => `  ${index + 1}) ${options.label(item)}`).join('\n')}\n`);
  while (true) {
    const answer = await prompt(`${options.promptText} (1-${choices.length}): `);
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index];
    process.stderr.write(`Enter a number from 1 to ${choices.length}.\n`);
  }
}
interface ChangeTarget { id: string; archived: boolean }
async function resolveChangeTarget(root: string, input: string): Promise<ChangeTarget> {
  const active = (await listChanges(root)).map(change => ({ ...change, archived: false }));
  const archived = await listArchivedChanges(root);
  const selected = await pickNamedValue(input, [...active, ...archived], {
    kind: 'Change', promptText: 'Select change', label: item => `${item.name} (${item.id})${item.archived ? ' [archived]' : ''}`, keys: item => [item.id, item.name],
  });
  if (!selected) throw new Error(`No change matched "${input}". Use a change name or ID from \`notchlet change list\`${archived.length ? ' or `notchlet change list --archived`' : ''}.`);
  return { id: selected.id, archived: selected.archived };
}
async function resolveChangeRef(root: string, input: string): Promise<string> {
  const target = await resolveChangeTarget(root, input);
  if (target.archived) throw new WorkflowError('archived_change', `Change ${target.id} is archived.`, `Restore it with \`notchlet change restore ${target.id}\` before editing.`);
  return target.id;
}
function changeItemHelp(action: 'add' | 'update', kind: ChangeItemKind): string {
  const usageLine = action === 'add'
    ? `notchlet change add <change> ${kind} --id <id> [fields] [--revision <n>]`
    : `notchlet change update <change> ${kind} <item-id> [fields] [--revision <n>]`;
  const fields: Record<ChangeItemKind, string> = {
    requirement: '--title <text> --description <text>',
    check: '--description <text> [--kind command|http|browser|ui|manual] [--command <cmd>] [--url <http(s) URL>] [--expected-status <n>] [--expected-body-contains <text>] [--expected-json <json>] [--expected-json-contains <json>] [--expected-json-at <json>] [--expected-header "Name: value"] [--wait-for <selector>] [--settle-ms <n>] [--expected-selector <selector>] [--expected-text <text>] [--expect-no-console-errors] [--full-page] [--working-directory <dir>] [--requirement <id[,id]>] [--scenario <id[,id]>] [--task <id[,id]>]',
    scenario: '--requirement <id> --when <text> --then <text>',
    decision: '--decision <text> --rationale <text>',
    task: '--title <text> [--requirement <id[,id]>] [--depends-on <id[,id]>]',
  };
  const examples: Record<ChangeItemKind, string> = {
    requirement: 'notchlet change add my-change requirement --id REQ-1 --title "Upload limits" --description "Uploads reject unsupported formats."',
    check: 'notchlet change add my-change check --id CHECK-1 --description "Run tests" --command "npm test" --requirement REQ-1 --task TASK-1',
    scenario: 'notchlet change add my-change scenario --id SCN-1 --requirement REQ-1 --when "a user uploads a PDF" --then "the request is rejected"',
    decision: 'notchlet change add my-change decision --id DEC-1 --decision "Validate at the API boundary" --rationale "One enforcement point"',
    task: 'notchlet change add my-change task --id TASK-1 --title "Implement upload validation" --requirement REQ-1',
  };
  return `${usageLine}

${action === 'add' ? 'Required fields' : 'Editable fields'}:
  ${fields[kind]}

Common options:
  --revision <n>      Expected change revision; rejects a stale write
  --workspace <root>  Set workspace root
  --json              Machine-readable JSON output

Example:
  ${examples[kind]}`;
}
const command = args.includes('--version') ? 'version' : positional[0] ?? 'help';
const envelope = (ok: boolean, data: unknown = null, error: CliJsonEnvelope['error'] = null, warnings: unknown[] = []): CliJsonEnvelope => ({ protocolVersion: 1, command, ok, data, error, warnings });
function print(data: unknown, human?: string): void { console.log(json ? JSON.stringify(envelope(true, data)) : human ?? JSON.stringify(data, null, 2)); }
function showCommandHelp(name: string, text: string): void {
  if (json) { print({ usage: text }, text); }
  else { console.log(text); }
  process.exitCode = 0;
  throw new Error('handled');
}
async function writeWorkspaceGuidance(root: string): Promise<{ written: string[]; existing: string[] }> {
  const agents = `# Agent guidance

This project uses Notchlet for change planning, implementation evidence, and local closure.

## Start here

1. Run \`notchlet status --json\` to find the active change and its blockers.
2. Read the change with \`notchlet change show <change>\` and follow \`notchlet instructions <change> --action implement\`.
3. Use the CLI (or local MCP tools) for authored metadata. Do not hand-edit \`tasks.json\`.

## Workflow

- Author requirements, scenarios, decisions, checks, and tasks before implementation.
- Import a structured plan with \`notchlet change new <name> --from plan.json --dry-run\`. Plan import renders canonical artifacts by default; pass \`--no-render\` to keep only plan-provided contents. Plans resolve from the working directory, \`.notchlet/plans/\`, or \`.notchlet/\`; the dry run lists every declared artifact with its role and full path.
- Plans may set \`capabilitySeed: true\` to author delta operations for every requirement, or declare explicit \`capabilityDelta\` operations.
- Record run and preview metadata with \`change update --run-command\`, \`--preview-url\`, \`--readiness-url\`, and optional \`--ready-timeout\`/\`--ready-interval\`; \`notchlet verify --serve\` starts the app, waits for readiness, and stops it after checks unless \`--keep-running\` is set.
- Reproduce runs with \`change update --environment KEY=value\`, \`--setup <cmd>\`, and \`--teardown <cmd>\`; these values are stored in change content and the evidence environment descriptor.
- Choose an evidence policy with \`change update --evidence-policy per-task|end-of-change\`. End-of-change suppresses per-task warnings but still requires current checks at closure.
- Link checks to requirements with \`--requirement\` and to scenarios with \`--scenario\`, then use \`change update --coverage-policy strict\` when every requirement and scenario must be covered by a check.
- Start dependency-eligible tasks with \`notchlet task start <task> --change <change>\`.
- Run command checks, HTTP checks, and rendered UI checks with \`notchlet verify <change> --record\`. HTTP checks may assert \`expectedStatus\`, \`expectedBodyContains\`, \`expectedJson\`, \`expectedJsonContains\`, \`expectedJsonAt\`, and \`expectedHeaders\`. UI checks wait for \`--wait-for\`, settle for \`--settle-ms\`, and assert \`--expected-selector\`, \`--expected-text\`, and \`--expect-no-console-errors\`; capture screenshots and DOM with \`--capture-url <url>\` and \`--full-page\`, or attach files with \`--attach <path>\`. Manual checks require recorded evidence.
- Use \`change update <change> check <check-id> --working-directory <dir>\` for nested apps; \`notchlet change path <change> [artifact]\` prints resolved paths.
- Complete tasks with \`notchlet task complete <task> --change <change> --require-evidence\`, or \`task complete --all\` in dependency order.
- Before closing, run \`notchlet change render <change> --write\` when artifacts drifted, then \`notchlet change close <change> --preview\`. Add \`--markdown\` only when human-readable views are wanted; JSON is canonical.

## Rules

- Never edit files marked \`generated by notchlet change render\`; update the model and rerun render.
- Do not claim verification without current passed evidence for the affected checks.
- \`revision\` advances on every persisted transition; \`contentRevision\` is bookkeeping only. Evidence freshness uses a fingerprint of authored content and non-derived artifacts, so task progress and rendering do not invalidate current evidence.
- Local closure does not mean remote delivery or deployment.
- Do not push, publish, deploy, or rewrite history without explicit human approval.
`;
  const prompt = `# Notchlet task prompt

Work inside this repository using the Notchlet workflow.

1. Inspect \`notchlet status --json\` and the active change.
2. Read \`notchlet instructions <change> --action resume\` and implement only eligible tasks.
3. Keep planning artifacts current with \`notchlet change render <change> --write\`; add \`--markdown\` only when optional Markdown views are requested.
4. Verify with \`notchlet verify <change> --record\`; record only observed outcomes. HTTP checks assert status/body/JSON/headers, legacy browser checks run as HTTP probes, UI checks assert settled rendered DOM/text/console, and manual checks require evidence files, \`--attach\`, or \`--capture-url\`. Use \`--serve\` when verify should own the app lifecycle; intentional shutdowns record their expected reason.
5. Preview closure with \`notchlet change close <change> --preview\` before archiving. If status and close preview disagree, resolve the listed closure blockers.
6. Ask before any push, publish, deploy, or destructive repository operation.

If the workspace is empty, start with \`notchlet change new <name> --from plan.json --dry-run\` to preview a declarative plan and its post-import setup steps. Keep reusable plans under \`.notchlet/plans/\`.
`;
  const readme = `# .notchlet workspace

Notchlet stores local change metadata and evidence here.

- \`workspace.json\` - workspace metadata.
- \`plans/\` - optional reusable change plans referenced by \`change new --from\`.
- \`changes/<id>/tasks.json\` - versioned change model (state). Author it through the CLI, not by hand.
- \`revision\` advances on every write; \`contentRevision\` advances only when authored content changes. Evidence freshness binds to the v2 fingerprint of authored content and non-derived artifacts, not to task progress.
- \`evidencePolicy\` is \`per-task\` (default) or \`end-of-change\`; closure still requires current checks.
- Checks may be \`command\`, \`http\` (URL + optional status/body/JSON/header assertions), \`browser\` (legacy HTTP alias), \`ui\` (rendered DOM, text, console, and captures), or \`manual\` (record evidence separately).
- \`runCommand\`, \`previewUrl\`, \`readinessUrl\`, \`readyTimeoutMs\`, and \`readyIntervalMs\` carry local run metadata; set them with \`notchlet change update\` rather than editing this file. \`notchlet verify --serve\` owns the app lifecycle and records an expected shutdown reason.
- \`environment\`, \`setupCommand\`, and \`teardownCommand\` make runs reproducible; \`coveragePolicy\` (\`advisory\` or \`strict\`) controls requirement/scenario/task coverage across direct check links, task links, and current passing evidence.
- \`changes/<id>/proposal.json\`, \`spec.json\` - canonical structured documents and default artifacts.
- \`changes/<id>/proposal.md\`, \`spec.md\`, \`tasks.md\` - optional generated views; add them with \`notchlet change render <id> --write --markdown\`.
- \`changes/<id>/design.md\` - hand-authored design notes for standard changes.
- \`changes/<id>/evidence.jsonl\` - append-only evidence records with freshness bindings.
- \`changes/<id>/evidence/logs/\` - bounded verification output logs.
- \`changes/<id>/evidence/<evidence-id>/\` - attached screenshots, DOM, text, or JSON evidence.
- \`archive/<id>/\` - closed changes, including \`closure.json\`, all evidence assets, and optional \`closure.md\` when close requested it.
- \`.local/close/\` - transient close journal; removed after a successful close.

Useful commands:

\`\`\`text
notchlet change list --json
notchlet change show <change>
notchlet change path <change> [artifact]
notchlet instructions <change> --action implement
notchlet change render <change> --check
notchlet verify <change> --record --serve --capture-url http://localhost:3000
notchlet schema closure.v1
notchlet change close <change> --preview
\`\`\`

Generated files carry a \`generated by notchlet change render\` marker. Change the model and rerun render instead of editing them.
`;
  const files = [
    ['AGENTS.md', agents],
    ['PROMPT.md', prompt],
    [path.join('.notchlet', 'README.md'), readme],
  ] as const;
  const written: string[] = [], existing: string[] = [];
  for (const [relative, content] of files) {
    const target = path.join(root, relative);
    try { await writeFile(target, content, { flag: 'wx' }); written.push(relative.split(path.sep).join('/')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') existing.push(relative.split(path.sep).join('/')); else throw error; }
  }
  return { written, existing };
}
function fail(code: string, message: string, recovery: string, exitCode: number): never {
  if (json) console.log(JSON.stringify(envelope(false, null, { code, message, recovery }, [])));
  else console.error(`${err(`${code}: ${message}`)}\nRecovery: ${recovery}`);
  process.exitCode = exitCode;
  throw new Error('handled');
}
const usage = `Usage: notchlet <command> [options]

${section('Setup')}
  init [path] [--local|--interactive]   Initialize a Notchlet workspace (local-only by default)

${section('Auth')}
  auth login [--server <url>] [--allow-file-token-store]   Log in to a Notchlet server
  auth status                                               Show current auth profile
  auth logout [--server <url>]                              Log out of a server
  profile use --server <url>                                Select the current server profile

${section('Workspace')}
  workspace bind --server <url> [--product <name>] [--repository <name>] [--rebind]   Bind checkout to a product/repository
  workspace info                                                        Show workspace binding and config
  doctor                                                                Diagnose workspace, binding, and server connectivity

${section('Sync')}
  sync mode auto|manual                                     Set automatic sync preference
  sync status|push|pull|resolve --change <name|id> [--yes] [--keep-local]   Sync a change with the remote

${section('Changes')}
  change new <name> [--quick] [--from <plan.json> [--dry-run] [--no-render] [--markdown]]   Create a change or import a declarative plan
  change list [--archived]                                  List active or archived changes
  change show <name|id>                                     Show change details and readiness
  status [<name|id> | --change <name|id>]                   Show workspace or change planning, execution, verification, and closure state
  validate <name|id>                                        Validate planning readiness and list blockers
  change restore <name|id>                                  Restore an archived change to active work
  change path <name|id> [artifact]                          Print the resolved change or artifact path
  change export <name|id> [--format json]                   Export a change, closure, evidence, and artifacts (raw JSON; add --json for the CLI envelope)
  change update <name|id> --intent <text> --outcome <text>   Update intent/outcome/capability/evidence/run metadata
  change update <name|id> <kind> <item-id> [fields]         Edit one authored item in place
  change add <name|id> requirement|check|scenario|decision|task [options]   Add authored content
  change remove <name|id> requirement|check|scenario|decision|task <item-id>   Remove authored content
  change convert <name|id> --schema quick|standard [--revision <n>]   Convert a change schema
  change apply <name|id> --file <path> [--revision <n>]     Apply an ordered authoring batch atomically
  change render <name|id> [--check|--write] [--force] [--markdown]       Render canonical and optional Markdown artifacts
  change plan status <name|id> | validate <path> | sync <name|id>        Inspect, validate, or accept plan provenance
  change close <name|id> --preview | --baseline-revision <n> [--yes] [--markdown] [--accept-plan-drift]   Close and archive a change

${section('Tasks')}
  task start <task-name|id> --change <name|id> --revision <n>  Start a task (--revision optional; defaults to current)
  task complete <task-name|id> --change <name|id> --revision <n> Complete a task (--revision optional)
  task complete --all --change <name|id>                   Complete remaining tasks in dependency order under one revision
  task update <change-name|id> <task-name|id> <status> [revision] Update a task status
  --force   Allow an out-of-order lifecycle transition
  --require-evidence   Block completion unless current passed evidence references the task

${section('Verification')}
  verify <name|id> [--check <id,...>] [--record] [--requirement <id,...>] [--scenario <id,...>] [--task <id,...>]   Run declared checks and optionally record scoped evidence
  verify <name|id> --serve [--keep-running] [--environment KEY=value] [--setup <cmd>] [--save-setup] [--teardown <cmd>] [--repeat <n>] [--check-setup-idempotence --setup-state <path>...]   Own the app lifecycle around checks and detect state-dependent failures
  verify <name|id> --record --capture-url <url> [--browser <path>] [--viewport <w>x<h>] [--wait-for <selector>] [--settle-ms <n>] [--full-page]   Capture one settled screenshot and DOM
  schema [name] [--dir]                                     List or print shipped JSON schemas

${section('Other')}
  backlog import <item-key|title|id> [--product-id <id>]     Import a backlog item as a change
  checkpoint --change <name|id> --name <name> [--summary <text>] [--backlog-status TODO|IN_PROGRESS|IN_REVIEW|DONE]   Create a remote checkpoint
  link --change <name|id> [--backlog-item <id>] [--repository <id>]   Link a synchronized change to a backlog item or repository
  evidence record --change <name|id> [--file <json-path>] [--summary <text>] [--kind <kind>] [--outcome <state>] [--capture-url <url>]   Record evidence
  evidence list --change <name|id> [--check|--requirement|--task <id>] [--stale] [--failed]   List scoped evidence with freshness and recovery
  instructions <change-name|id> [--action plan|revise|implement|verify|resume] Get workflow instructions for a change
  client init|update <agent> [--apply]                       Install client guidance (skills)

${section('MCP')}
  init --local --client <agent>                             Initialize and configure the offline MCP server
  mcp serve --local                                         Run the offline local MCP server (no account needed)
  mcp serve --server <url> [--client <agent>]              Run the local stdio MCP bridge to a Notchlet server
  mcp configure --client <agent> [--transport bridge|remote|local]   Write MCP project configuration
  mcp status [--server <url>] [--client <agent>]           Show MCP setup, credential, and config state
  mcp token [--server <url>]                                Print the stored MCP credential for environment setup
  mcp disconnect [--client <agent>] [--revoke] [--yes]     Remove this project's MCP entry
  mcp revoke [--server <url>] [--credential-id <id>] [--yes] Revoke the stored MCP credential

${section('Global options')}
  --json           Machine-readable JSON output
  --workspace <root> / --root <root>   Set workspace root
  --server <url>   Notchlet server (default: ${DEFAULT_SERVER})
  --version        Show version
`;

function deriveStatus(state: ReturnType<typeof evaluateState>): string {
  return `Tasks: ${state.execution.completed}/${state.execution.total} completed${state.execution.inProgress ? `, ${state.execution.inProgress} in progress` : ''}. Planning: ${state.planning.status}; verification: ${state.verification.status}; local closure: ${state.localClosure.status}; close readiness: ${state.closure.evaluated ? (state.closure.ready ? 'ready' : `${state.closure.blockerCount} blocker(s)`) : 'not evaluated'}; remote delivery: ${state.remoteDelivery.status}. Completion does not imply verification or delivery.`;
}

function executionMetadata(change: Awaited<ReturnType<typeof readChange>>) {
  return {
    ...(change.runCommand === undefined ? {} : { runCommand: change.runCommand }),
    ...(change.setupCommand === undefined ? {} : { setupCommand: change.setupCommand }),
    ...(change.teardownCommand === undefined ? {} : { teardownCommand: change.teardownCommand }),
    ...(change.previewUrl === undefined ? {} : { previewUrl: change.previewUrl }),
    ...(change.readinessUrl === undefined ? {} : { readinessUrl: change.readinessUrl }),
    ...(change.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: change.readyTimeoutMs }),
    ...(change.readyIntervalMs === undefined ? {} : { readyIntervalMs: change.readyIntervalMs }),
    ...(change.environment === undefined ? {} : { environment: change.environment }),
  };
}

const EXECUTION_FIELDS = new Set(['runCommand', 'previewUrl', 'readinessUrl', 'readinessExpectedStatus', 'readinessBodyContains', 'environment', 'setupCommand', 'teardownCommand', 'workingDirectory', 'readyTimeoutMs', 'readyIntervalMs']);

function executionDriftWarnings(id: string, drift: ReturnType<typeof inspectExecutionDrift>): unknown[] {
  if (drift.status !== 'drifted') return [];
  return [{
    code: 'execution_metadata_drift',
    message: `Execution metadata in ${id} changed outside the CLI without a revision bump (recorded ${drift.recordedSha256?.slice(0, 12)}, now ${drift.currentSha256.slice(0, 12)}).`,
    recovery: drift.recovery,
  }];
}
const sentence = (value: string): string => value.trim().replace(/[.!?]+$/, '');

async function syncIfAutomatic(root: string, changeId: string) {
  let mode: string;
  try {
    const workspace = JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'));
    mode = workspace.preferences?.syncMode === 'auto' ? 'auto' : 'manual';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') mode = 'manual';
    else throw error;
  }
  if (mode !== 'auto') return null;
  const { autoSyncChange } = await import('./integration.js');
  return autoSyncChange(root, changeId, { server: optionValue('--server'), endpoint: optionValue('--endpoint') });
}

function warningText(warning: unknown): string {
  if (typeof warning === 'string') return warning;
  const value = warning as { code?: string; message?: string; recovery?: string };
  return `${value.code ?? 'warning'}: ${value.message ?? JSON.stringify(warning)}${value.recovery ? ` Recovery: ${value.recovery}` : ''}`;
}

function printWithSync(result: unknown, automaticSync: unknown | null, human?: string, warnings: unknown[] = []) {
  const base = json ? JSON.stringify(envelope(true, result, null, warnings)) : human ?? JSON.stringify(result, null, 2);
  const warningLines = json ? '' : warnings.map(warning => `\n${warn(warningText(warning))}`).join('');
  if (!automaticSync) { console.log(`${base}${warningLines}`); return; }
  const syncState = (automaticSync as any)?.state ?? 'pending';
  if (json) { console.log(JSON.stringify(envelope(true, { result, automaticSync }, null, warnings))); }
  else { console.log(`${base}${warningLines}\nAutomatic sync: ${syncState}`); }
}

const EVIDENCE_INPUT_LIMIT_BYTES = 32 * 1024;
function parseEvidenceWriteInput(value: unknown): EvidenceWriteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Evidence input must be a JSON object.');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['id', 'kind', 'outcome', 'summary', 'command', 'requirementIds', 'scenarioIds', 'taskIds', 'checkIds', 'attachments', 'capturedAt', 'provenance', 'environment', 'capture']);
  const unsupported = Object.keys(record).find(key => !allowed.has(key));
  if (unsupported) throw new Error(`Unsupported evidence field: ${unsupported}.`);
  if (!['check', 'note', 'artifact'].includes(String(record.kind))) throw new Error('Evidence kind must be check, note, or artifact.');
  if (!['passed', 'failed', 'informational'].includes(String(record.outcome))) throw new Error('Evidence outcome must be passed, failed, or informational.');
  if (typeof record.summary !== 'string' || !record.summary.trim()) throw new Error('Evidence summary must be a non-empty string.');
  if (!Array.isArray(record.requirementIds) || !record.requirementIds.every(item => typeof item === 'string')) throw new Error('Evidence requirementIds must be an array of strings.');
  if (!Array.isArray(record.taskIds) || !record.taskIds.every(item => typeof item === 'string')) throw new Error('Evidence taskIds must be an array of strings.');
  if (record.checkIds !== undefined && (!Array.isArray(record.checkIds) || !record.checkIds.every(item => typeof item === 'string'))) throw new Error('Evidence checkIds must be an array of strings.');
  if (record.command !== undefined && typeof record.command !== 'string') throw new Error('Evidence command must be a descriptive string.');
  if (record.provenance !== 'recorded' && record.provenance !== 'imported') throw new Error('Evidence provenance must be recorded or imported.');
  return record as unknown as EvidenceWriteInput;
}

async function artifactContents(root: string, id: string, change: Awaited<ReturnType<typeof readChange>>, options: { archived?: boolean } = {}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const directory = path.join(root, '.notchlet', options.archived ? 'archive' : 'changes', id);
  for (const relative of Object.values(change.artifacts)) {
    try { result[relative] = await readFile(path.join(directory, relative), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}

async function readArchivedClosure(root: string, id: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path.join(root, '.notchlet', 'archive', id, 'closure.json'), 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function verificationFacets(root: string, id: string, change: Awaited<ReturnType<typeof readChange>>) {
  return evaluateVerificationFacets(root, id, change);
}

async function renderHint(root: string, id: string): Promise<string | undefined> {
  try {
    const state = await inspectChangeArtifacts(root, id);
    const stale = state.artifacts.filter(artifact => artifact.status !== 'current').map(artifact => `${artifact.artifact}:${artifact.status}`);
    return stale.length ? `Generated artifacts changed: ${stale.join(', ')}. Refresh with \`notchlet change render ${id} --write\`.` : undefined;
  } catch { return undefined; }
}

async function requireWorkspace(what: string): Promise<string> {
  const root = await workspace();
  if (!root) fail('setup_required', `No initialized Notchlet workspace was found.`, `Run \`notchlet init\` before \`${what}\`.`, 2);
  return root;
}

/** Plans resolve from the working directory first, then the workspace `.notchlet` directories. */
async function resolvePlanPath(root: string | null | undefined, input: string): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), input),
    path.resolve(process.cwd(), '.notchlet', 'plans', input),
    path.resolve(process.cwd(), '.notchlet', input),
    ...(root === undefined || root === null ? [] : [path.resolve(root, '.notchlet', 'plans', input), path.resolve(root, '.notchlet', input)]),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; }
    catch { /* try the next documented location */ }
  }
  fail('plan_not_found', `Could not read change plan: ${input}.`, `Provide a readable JSON plan path, or place it at ${path.join('.notchlet', 'plans', path.basename(input))} inside the workspace.`, 1);
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

async function main() {
  try {
    // Command-specific --help is handled inside each command block below.
    // Only show general help when there's no command or command is literally 'help'.
    if ((command === 'help' || positional.length === 0) && (args.includes('--help') || args.includes('-h') || command === 'help')) {
      print({ usage }, usage);
    }
    else if (args.includes('--version') || command === 'version') {
      const version = await packageVersion();
      print({ version, coreVersion: CORE_VERSION }, `notchlet ${version} · @notchlet/core ${CORE_VERSION}`);
    }
    else if (command === 'auth') {
      const action = positional[1];
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('auth', `notchlet auth <action> [options]

  login [--server <url>] [--allow-file-token-store]   Log in to a Notchlet server
  status                                               Show current auth profile
  logout [--server <url>]                              Log out of a server

Options:
  --server <url>   Notchlet server (default: ${DEFAULT_SERVER})
  --allow-file-token-store   Allow restricted file credential storage (Windows requires this or NOTCHLET_TOKEN)
  --json           Machine-readable JSON output`);
      }
      if (!['login', 'status', 'logout'].includes(action ?? '')) fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
      const { authCommand } = await import('./auth.js');
      const result = await authCommand(action, { server: action === 'login' ? serverOption() : optionValue('--server'), allowFileStore: args.includes('--allow-file-token-store'), json });
      if (json) { print(result); }
      else if (action === 'login') {
        const p = (result as any).profile;
        console.log(box([
          section('Logged in'),
          kv('Server', p.origin),
          kv('Email', p.email ?? '(not provided)'),
          kv('Auth mode', p.authMode ?? '(unknown)'),
          kv('Credential store', (result as any).credential.source),
          kv('Credential status', (result as any).credential.status),
        ]));
      } else if (action === 'status') {
        const p = (result as any).profile;
      console.log(box([
        section('Auth status'),
        kv('Server', p.origin),
        kv('Email', p.email ?? '(not provided)'),
        kv('Current profile', (result as any).current ? 'yes' : 'no'),
        kv('Auth mode', p.authMode ?? '(unknown)'),
        kv('Credential source', (result as any).credential.source),
        kv('Credential status', (result as any).credential.status),
      ]));
      } else {
        console.log(box([
          section('Logged out'),
          kv('Server', (result as any).profile),
          kv('Server logout', (result as any).serverLogout),
          kv('Credential status', (result as any).credential.status),
        ]));
      }
    } else if (command === 'profile' && positional[1] === 'use') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('profile use', `notchlet profile use --server <url>

  Select the current server profile.

Options:
  --server <url>   Notchlet server (default: ${DEFAULT_SERVER})
  --json           Machine-readable JSON output`);
      }
      const origin = await requiredString(serverOption(), `Notchlet server HTTPS origin [${DEFAULT_SERVER}]: `) ?? DEFAULT_SERVER;
      const { selectProfile } = await import('./auth.js');
      const profile = await selectProfile(origin);
      if (!profile) fail('profile_not_found', `No profile exists for ${origin}.`, `Run \`notchlet auth login --server ${origin}\` first.`, 2);
      if (json) { print({ profile, current: true }); }
      else {
        console.log(box([
          section('Profile selected'),
          kv('Server', profile.origin),
          kv('Auth mode', profile.authMode ?? '(unknown)'),
          kv('Current', 'yes'),
        ]));
      }
    }
    else if (command === 'workspace' && ['bind', 'rebind'].includes(positional[1] ?? '')) {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('workspace bind', `notchlet workspace bind --server <url> [--product <name|id>] [--repository <name|owner/repo|id>] [--rebind]

  Bind a Git checkout to a Notchlet product and repository.

Options:
  --server <url>             Notchlet server (default: ${DEFAULT_SERVER})
  --product <name|id>        Product name or ID (defaults to an interactive picker)
  --repository <name|owner/repo|id>  Repository name or ID (defaults to an interactive picker)
  --product-id <id>          Product ID (numeric, retained for scripts)
  --repository-id <id>       Repository ID (numeric, retained for scripts)
  --rebind                   Confirm rebinding if the workspace is already bound
  --endpoint <url>           Override MCP endpoint
  --allow-file-token-store   Allow restricted file credential storage
  --json                     Machine-readable JSON output`);
      }
      const root = await requireWorkspace('workspace bind');
      const server = await requiredString(serverOption(), `Notchlet server HTTPS origin [${DEFAULT_SERVER}]: `) ?? DEFAULT_SERVER;
      const productQuery = optionValue('--product') ?? optionValue('--product-id');
      const repositoryQuery = optionValue('--repository') ?? optionValue('--repository-id');
      let product: any;
      let repository: any;
      if (/^\d+$/.test(productQuery ?? '') && /^\d+$/.test(repositoryQuery ?? '')) {
        product = { id: Number(productQuery) };
        repository = { id: Number(repositoryQuery) };
      } else {
        const { platformApi } = await import('./integration.js');
        const api = await platformApi(server, { allowFileStore: args.includes('--allow-file-token-store') });
        const organizations = await api.get('/organizations/mine') as Array<{ id: number; name: string }>;
        const allProducts: any[] = [];
        for (const organization of organizations) {
          const products = await api.get(`/products?organizationId=${organization.id}`) as any[];
          allProducts.push(...products.map(item => ({ ...item, organizationName: organization.name })));
        }
        product = await pickNamedValue(productQuery, allProducts, {
          kind: 'Product', promptText: 'Select product',
          label: item => `${item.name} · ${item.organizationName} (#${item.id})`,
          keys: item => [item.name, item.organizationName, `${item.name} ${item.organizationName}`, String(item.id)],
        });
        if (!product) fail('product_not_found', `No product matched ${productQuery ? `"${productQuery}"` : 'the selection'}.`, 'Choose a product available to this account or provide --product-id.', 2);
        const repositories = await api.get(`/git/config?productId=${product.id}`);
        const repositoryList = Array.isArray(repositories) ? repositories : repositories ? [repositories] : [];
        repository = await pickNamedValue(repositoryQuery, repositoryList, {
          kind: 'Repository', promptText: 'Select repository',
          label: item => `${item.repoLabel ?? `${item.repoOwner ?? ''}/${item.repoName ?? ''}`} · ${item.provider ?? 'Git'} (#${item.id})`,
          keys: item => [item.repoLabel, `${item.repoOwner ?? ''}/${item.repoName ?? ''}`, item.repoName, String(item.id)].filter(Boolean),
        });
        if (!repository) fail('repository_not_found', `No repository matched ${repositoryQuery ? `"${repositoryQuery}"` : 'the selection'}.`, 'Choose a repository connected to this product or provide --repository-id.', 2);
      }
      if (!Number.isSafeInteger(Number(product.id)) || !Number.isSafeInteger(Number(repository.id))) fail('usage_error', usage, 'Provide a product and repository available to your account.', 64);
      const { bindWorkspace } = await import('./integration.js');
      const result = await bindWorkspace(root, { server, productId: Number(product.id), repositoryId: Number(repository.id), endpoint: optionValue('--endpoint'), rebind: positional[1] === 'rebind' || args.includes('--rebind'), allowFileStore: args.includes('--allow-file-token-store') });
      if (json) { print(result); }
      else {
        const b = (result as any).binding;
        console.log(box([
          section(result.alreadyBound ? 'Workspace already bound' : 'Workspace bound'),
          kv('Server', b.server),
          kv('Product ID', String(b.productId)),
          kv('Repository ID', String(b.repositoryId)),
          kv('Repository remote', b.repositoryRemote),
          kv('Git root', b.gitRoot),
          kv('Sync mode', 'manual (run `notchlet sync mode auto` to enable automatic sync)'),
        ]));
      }
    }
    else if (command === 'workspace' && positional[1] === 'info') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('workspace info', `notchlet workspace info

  Show the current workspace binding and configuration.

Options:
  --workspace <root> / --root <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('workspace info');
      const workspaceFile = path.join(root, '.notchlet', 'workspace.json');
      let workspaceData: any = {};
      try {
        workspaceData = JSON.parse(await readFile(workspaceFile, 'utf8'));
      } catch {
        workspaceData = {};
      }
      if (json) { print(workspaceData); }
      else {
        const lines: string[] = [];
        lines.push(section('Workspace info'));
        lines.push(kv('Root', root));
        lines.push(kv('Sync mode', workspaceData.preferences?.syncMode ?? 'manual'));
        const b = workspaceData.binding;
        if (b) {
          lines.push(divider());
          lines.push(section('Binding'));
          lines.push(kv('Server', b.server));
          lines.push(kv('Server identity', b.serverIdentity));
          lines.push(kv('Product ID', String(b.productId)));
          lines.push(kv('Repository ID', String(b.repositoryId)));
          lines.push(kv('Repository remote', b.repositoryRemote));
          lines.push(kv('Git root', b.gitRoot));
          lines.push(kv('Endpoint', b.endpoint ?? '(default)'));
          lines.push(kv('Core version', b.coreVersion ?? '(unknown)'));
          lines.push(kv('Schema version', b.schemaVersion ?? '(unknown)'));
          if (b.protocol) lines.push(kv('Protocol', JSON.stringify(b.protocol)));
        } else {
          lines.push(divider());
          lines.push(section('Binding'));
          lines.push(warn('Not bound. Run `notchlet workspace bind` to connect.'));
        }
        console.log(box(lines));
      }
    }
    else if (command === 'doctor') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('doctor', `notchlet doctor [--server <url>]

  Diagnose workspace, binding, git, and server connectivity.

Options:
  --server <url>             Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>           Override MCP endpoint
  --allow-file-token-store   Allow restricted file credential storage
  --json                     Machine-readable JSON output`);
      }
      const root = await workspace();
      const { doctor } = await import('./integration.js');
      const result = await doctor(root, { server: optionValue('--server'), endpoint: optionValue('--endpoint'), allowFileStore: args.includes('--allow-file-token-store') });
      if (json) { print(result); }
      else {
        const p = result.profile;
        const lines: string[] = [];
        lines.push(section('Notchlet doctor'));
        lines.push(kv('Server', p?.origin ?? '(none)'));
        lines.push(kv('Auth mode', p?.authMode ?? '(none)'));
        lines.push(kv('Backend', result.online ? ok('reachable') : err('offline')));
        lines.push(kv('Diagnostic', result.diagnostic));
        lines.push(kv('Git', result.git.isRepository ? ok(result.git.repository.topLevel) : err(result.git.reason ?? 'not a repository')));
        lines.push(kv('Binding', result.binding ? ok('configured') : err('none')));
        if (result.capabilities) lines.push(kv('Server version', result.capabilities.server?.version ?? '(unknown)'));
        if (result.authScopes?.length) lines.push(kv('Auth scopes', result.authScopes.join(', ')));
        console.log(box(lines));
      }
    }
    else if (command === 'sync' && positional[1] === 'mode') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('sync mode', `notchlet sync mode auto|manual

  Set automatic sync preference for the workspace.

Options:
  --workspace <root> / --root <root>   Set workspace root
  --json           Machine-readable JSON output`);
      }
      const root = await requireWorkspace('sync mode');
      const mode = positional[2] ?? (isTty() ? await prompt('Sync mode (auto|manual): ') : undefined);
      if (mode !== 'auto' && mode !== 'manual') fail('usage_error', usage, 'Choose `notchlet sync mode auto` or `notchlet sync mode manual`.', 64);
      const { setWorkspaceSyncMode } = await import('./integration.js');
      const result = await setWorkspaceSyncMode(root, mode);
      if (json) print({ ...result, workspace: root });
      else console.log(box([
        section('Sync mode updated'),
        kv('Workspace', root),
        kv('Sync mode', result.syncMode),
      ]));
    }
    else if (command === 'sync') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('sync', `notchlet sync <action> --change <name|id> [--yes] [--keep-local]

  status   Show sync state of a change
  push     Push local change to remote
  pull     Pull remote change to local
  resolve  Resolve a conflict (requires --keep-local)

Options:
  --change <name|id>   Change name or ID (required)
  --yes                Skip confirmation prompt
  --keep-local         Keep local changes when resolving (required for resolve)
  --server <url>       Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>     Override MCP endpoint
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('sync');
      const action = positional[1];
      let id = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
      if (!['status', 'push', 'pull', 'resolve'].includes(action ?? '') || !id) fail('usage_error', usage, 'Use `notchlet sync <status|push|pull|resolve> --change <name|id> [--yes] [--keep-local]`.', 64);
      id = await resolveChangeRef(root, id);
      const { syncStatus, syncPush, syncPull, syncResolve } = await import('./integration.js');
      const syncOptions = { server: optionValue('--server'), endpoint: optionValue('--endpoint'), yes: args.includes('--yes') };
      if (action === 'status') {
        const automaticSync = await syncIfAutomatic(root, id);
        const result = await syncStatus(root, id, syncOptions);
        if (json) { print({ ...result, ...(automaticSync ? { automaticSync } : {}) }); }
        else {
          const lines: string[] = [];
          lines.push(section(`Sync status: ${id}`));
          lines.push(kv('State', result.state));
          lines.push(kv('Remote ID', result.remoteId ?? '(none)'));
          lines.push(kv('Local hash', result.localHash));
          lines.push(kv('Remote hash', result.remoteHash ?? '(none)'));
          lines.push(kv('Base hash', result.baseHash ?? '(none)'));
          lines.push(kv('Remote captured at', result.remoteCapturedAt ?? '(none)'));
          if (automaticSync) lines.push(kv('Automatic sync', (automaticSync as any).state ?? 'pending'));
          console.log(box(lines));
        }
      } else {
        const yes = args.includes('--yes');
        if (!yes && action !== 'status' && isTty()) {
          const confirmed = await confirm(`Are you sure you want to \`${action}\` change ${id}?`);
          if (!confirmed) { console.log(warn('Cancelled.')); return; }
        }
        const result = action === 'push' ? await syncPush(root, id, syncOptions) : action === 'pull' ? await syncPull(root, id, syncOptions) : await syncResolve(root, id, 'keep-local', syncOptions);
        if (json) { print(result); }
        else {
          const lines: string[] = [];
          lines.push(section(`Sync ${action}: ${id}`));
          lines.push(kv('State', result.state));
          lines.push(kv('Remote ID', result.remoteId ?? '(none)'));
          if ((result as any).revision !== undefined) lines.push(kv('Revision', String((result as any).revision)));
          if ((result as any).hash) lines.push(kv('Hash', (result as any).hash));
          if ((result as any).nextAction) lines.push(kv('Next action', (result as any).nextAction));
          if ((result as any).conflict) lines.push(kv('Conflict', warn((result as any).conflict)));
          if ((result as any).automatic) lines.push(kv('Automatic', 'yes'));
          console.log(box(lines));
        }
      }
    }
    else if (command === 'client') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('client', `notchlet client init|update <agent> [--apply]

  init    Install all Notchlet client guidance skills
  update  Update all installed Notchlet client guidance skills

Skills installed:
  notchlet-mcp, notchlet-platform, notchlet-plan, notchlet-implement, notchlet-review, notchlet-deliver, notchlet-super, notchlet-init

Targets:
  opencode   .opencode/skills/<skill>/SKILL.md
  claude     .claude/skills/<skill>/SKILL.md
  agent      .agents/skills/<skill>/SKILL.md

Options:
  --apply    Actually write the guidance files (without this, only previews)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('client');
      const action = positional[1], client = positional[2];
      if (!['init', 'update'].includes(action ?? '') || !['opencode', 'claude', 'agent'].includes(client ?? '')) fail('usage_error', usage, 'Use `notchlet client init|update opencode|claude|agent [--apply]`.', 64);
      const { installClientGuidance } = await import('./guidance-install.js');
      const result = await installClientGuidance(root, client as 'opencode' | 'claude', { apply: args.includes('--apply') });
      if (json) { print(result); }
      else {
        const lines: string[] = [];
        lines.push(section(`Client guidance: ${result.action}`));
        lines.push(kv('Client', result.client));
        const appliedCount = result.results.filter(r => r.applied).length;
        lines.push(kv('Skills', `${appliedCount}/${result.results.length} ${result.applied ? ok('applied') : warn('preview (use --apply to install)')}`));
        for (const r of result.results) {
          const status = r.applied ? ok(r.action) : r.action === 'unchanged' ? warn('unchanged') : err(r.action);
          lines.push(kv(r.skill, `${status}${r.reason ? ` - ${r.reason}` : ''}`));
        }
        console.log(box(lines));
      }
    }
    else if (command === 'checkpoint') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('checkpoint', `notchlet checkpoint --change <name|id> --name <name> [--summary <text>] [--backlog-status TODO|IN_PROGRESS|IN_REVIEW|DONE]

  Create a remote checkpoint on a synchronized change.

Options:
  --change <name|id>         Change name or ID (required)
  --name <name>              Checkpoint name (required, max 100 chars)
  --summary <text>           Checkpoint summary (max 4096 chars)
  --backlog-status <status>  Backlog status: TODO, IN_PROGRESS, IN_REVIEW, or DONE
  --server <url>             Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>           Override MCP endpoint
  --workspace <root>         Set workspace root
  --json                     Machine-readable JSON output`);
      }
      const root = await requireWorkspace('checkpoint');
      const changeRef = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
      const name = optionValue('--name') ?? (isTty() && !changeRef ? await prompt('Checkpoint name: ') : undefined);
      const backlogStatus = optionValue('--backlog-status');
      if (!changeRef || !name || (backlogStatus !== undefined && !['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'].includes(backlogStatus))) fail('usage_error', usage, 'Provide --change, --name, and an optional supported --backlog-status.', 64);
      const id = await resolveChangeRef(root, changeRef);
      const { syncCheckpoint } = await import('./integration.js');
      const result = await syncCheckpoint(root, id, { name, ...(optionValue('--summary') === undefined ? {} : { summary: optionValue('--summary') }), ...(backlogStatus === undefined ? {} : { backlogStatus: backlogStatus as 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' }) }, { server: optionValue('--server'), endpoint: optionValue('--endpoint') });
      if (json) { print(result); }
      else {
        const c = (result as any).checkpoint;
        const lines: string[] = [];
        lines.push(section('Checkpoint created'));
        lines.push(kv('Change', id));
        lines.push(kv('Remote ID', result.remoteId));
        lines.push(kv('Name', c?.name ?? name));
        lines.push(kv('Snapshot revision', String(c?.snapshotRevision ?? '(unknown)')));
        if (c?.summary) lines.push(kv('Summary', c.summary));
        if (c?.backlogStatus) lines.push(kv('Backlog status', c.backlogStatus));
        console.log(box(lines));
      }
    }
    else if (command === 'link') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('link', `notchlet link --change <name|id> [--backlog-item <id>] [--repository <id>]

  Link a synchronized change to a backlog item or repository so the platform Development tab can find it.

Options:
  --change <name|id>      Change name or ID (required)
  --backlog-item <id>     Backlog item ID to link
  --repository <id>       Repository ID to link
  --server <url>          Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>        Override MCP endpoint
  --workspace <root>      Set workspace root
  --json                  Machine-readable JSON output`);
      }
      const root = await requireWorkspace('link');
      const changeRef = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
      const backlogItemId = optionValue('--backlog-item') === undefined ? undefined : Number(optionValue('--backlog-item'));
      const repositoryId = optionValue('--repository') === undefined ? undefined : Number(optionValue('--repository'));
      const validId = (value: number | undefined) => value === undefined || (Number.isSafeInteger(value) && value > 0);
      if (!changeRef || (backlogItemId === undefined && repositoryId === undefined) || !validId(backlogItemId) || !validId(repositoryId)) fail('usage_error', usage, 'Provide --change and at least one of --backlog-item or --repository.', 64);
      const id = await resolveChangeRef(root, changeRef);
      const { linkChange } = await import('./integration.js');
      const result = await linkChange(root, id, { ...(backlogItemId === undefined ? {} : { backlogItemId }), ...(repositoryId === undefined ? {} : { repositoryId }) }, { server: optionValue('--server'), endpoint: optionValue('--endpoint') });
      if (json) { print(result); }
      else {
        const lines: string[] = [];
        lines.push(section('Change linked'));
        lines.push(kv('Change', id));
        lines.push(kv('Remote ID', result.remoteId));
        if (result.change?.backlogItemId !== undefined) lines.push(kv('Backlog item', result.change.backlogItemId == null ? '(none)' : String(result.change.backlogItemId)));
        if (result.change?.repositoryId !== undefined) lines.push(kv('Repository', result.change.repositoryId == null ? '(none)' : String(result.change.repositoryId)));
        console.log(box(lines));
      }
    }
    else if (command === 'evidence' && positional[1] === 'record') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('evidence record', `notchlet evidence record --change <name|id> [--file <json-path>] [flags]

  Record evidence for a change. Either provide a JSON file, or build the record from flags.

Options:
  --change <name|id>  Change name or ID (required)
  --file <path>    Path to evidence JSON file (optional, max 32 KiB)
  --summary <text> Evidence summary (required unless --file is used)
  --kind <kind>    check|note|artifact (default: note; check when --capture-url is used)
  --outcome <state>  passed|failed|informational (default: informational)
  --command <text>   Command or inspection that produced the evidence
  --requirement <id,...>  Link requirements (repeatable/comma-separated)
  --scenario <id,...>     Link scenarios
  --task <id,...>         Link tasks
  --check <id,...>        Link checks
  --capture-url <url>     Capture a headless screenshot and DOM snapshot of the running app
  --browser <path>        Browser executable used by --capture-url
  --viewport <w>x<h>      Capture viewport (default 1280x900)
  --attach <path>         Copy a file into the change evidence (repeatable)
                          Optional metadata: path::name::kind::description
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('evidence record');
      const changeRef = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
      if (!changeRef) fail('usage_error', usage, 'Provide --change for evidence record.', 64);
      const id = await resolveChangeRef(root, changeRef);
      const file = optionValue('--file');
      const attachments = rawOptionValues('--attach');
      const captureUrl = optionValue('--capture-url');
      let base: EvidenceWriteInput;
      if (file) {
        const source = await readFile(path.resolve(process.cwd(), file), 'utf8');
        if (Buffer.byteLength(source, 'utf8') > EVIDENCE_INPUT_LIMIT_BYTES) fail('payload_too_large', 'Evidence input exceeds 32 KiB.', 'Split the evidence into smaller records and try again.', 5);
        let value: unknown;
        try { value = JSON.parse(source); } catch { fail('invalid_input', 'Evidence input is not valid JSON.', 'Correct the JSON file and try again.', 2); }
        base = parseEvidenceWriteInput(value);
      } else {
        const summary = optionValue('--summary');
        if (!summary?.trim()) fail('usage_error', 'Provide --summary when recording evidence without --file.', 'Describe what was observed, for example --summary "Manually checked checkout totals".', 64);
        const kind = optionValue('--kind') ?? (captureUrl ? 'check' : 'note');
        if (!['check', 'note', 'artifact'].includes(kind)) fail('usage_error', 'Use --kind check, --kind note, or --kind artifact.', 'Choose a supported evidence kind.', 64);
        const outcome = optionValue('--outcome') ?? 'informational';
        if (!['passed', 'failed', 'informational'].includes(outcome)) fail('usage_error', 'Use --outcome passed, --outcome failed, or --outcome informational.', 'Choose a supported evidence outcome.', 64);
        base = {
          kind: kind as EvidenceWriteInput['kind'],
          outcome: outcome as EvidenceWriteInput['outcome'],
          summary,
          requirementIds: optionValues('--requirement'),
          taskIds: optionValues('--task'),
          ...(optionValue('--scenario') === undefined ? {} : { scenarioIds: optionValues('--scenario') }),
          ...(optionValue('--check') === undefined ? {} : { checkIds: optionValues('--check') }),
          ...(optionValue('--command') === undefined ? {} : { command: optionValue('--command') }),
          provenance: 'recorded',
        };
      }
      let capture: { url: string; browser: string; capturedAt: string; viewport: { width: number; height: number } } | undefined;
      let captureAttachments: Awaited<ReturnType<typeof stageEvidenceAttachments>> = [];
      const evidenceId = base.id ?? randomUUID();
      if (captureUrl) {
        const { capturePage } = await import('./capture.js');
        const page = await capturePage({
          url: captureUrl,
          ...(optionValue('--browser') === undefined ? {} : { browser: optionValue('--browser') }),
          ...(viewportOption() === undefined ? {} : { viewport: viewportOption() }),
        });
        try {
          const provenance = { tool: 'browser-capture' as const, url: page.url, browser: page.browser, capturedAt: page.capturedAt };
          captureAttachments = await stageEvidenceAttachments(root, id, evidenceId, [
            { path: page.screenshot.path, name: 'capture.png', kind: 'screenshot', description: `Headless screenshot of ${page.url}`, provenance },
            { path: page.dom.path, name: 'capture.html', kind: 'dom', description: `DOM snapshot of ${page.url}`, provenance },
          ]);
          capture = { url: page.url, browser: page.browser, capturedAt: page.capturedAt, viewport: page.viewport };
        } finally { await page.cleanup(); }
      }
      const attachmentInputs = attachments.map(value => {
        const [filePath, name, kind, description] = value.split('::');
        if (kind !== undefined && kind !== '' && !['screenshot', 'dom', 'text', 'json', 'other'].includes(kind)) fail('usage_error', `Invalid attachment kind: ${kind}`, 'Use screenshot, dom, text, json, or other after the second :: separator.', 64);
        return {
          path: filePath,
          ...(name ? { name } : {}),
          ...(kind ? { kind: kind as 'screenshot' | 'dom' | 'text' | 'json' | 'other' } : {}),
          ...(description ? { description } : {}),
        };
      });
      const staged = attachmentInputs.length ? await stageEvidenceAttachments(root, id, evidenceId, attachmentInputs) : [];
      const allAttachments = [...captureAttachments, ...(base.attachments ?? []), ...staged];
      const evidence = await appendEvidence(root, id, {
        ...base,
        id: evidenceId,
        ...(capture === undefined ? {} : { capture }),
        ...(allAttachments.length ? { attachments: allAttachments } : {}),
      });
      printWithSync(evidence, await syncIfAutomatic(root, id), `Recorded ${evidence.kind} evidence ${evidence.id} for ${id}.`);
    }
    else if (command === 'evidence' && positional[1] === 'list') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('evidence list', `notchlet evidence list --change <name|id> [--check <id>] [--requirement <id>] [--task <id>] [--stale] [--failed]

  List recorded evidence with scope, freshness, and recovery guidance.

Options:
  --change <name|id>  Change name or ID (required)
  --check <id>        Only records linked to this check
  --requirement <id>  Only records linked to this requirement
  --task <id>         Only records linked to this task
  --stale             Only records whose freshness is stale
  --failed            Only records with a failed outcome
  --workspace <root>  Set workspace root
  --json              Machine-readable JSON output`);
      }
      const root = await requireWorkspace('evidence list');
      const changeRef = optionValue('--change') ?? positional[2];
      if (!changeRef) fail('usage_error', usage, 'Provide --change <name|id> for evidence list.', 64);
      const id = (await resolveChangeTarget(root, changeRef)).id;
      const listings = await inspectEvidence(root, id, {
        ...(optionValue('--check') === undefined ? {} : { checkId: optionValue('--check') }),
        ...(optionValue('--requirement') === undefined ? {} : { requirementId: optionValue('--requirement') }),
        ...(optionValue('--task') === undefined ? {} : { taskId: optionValue('--task') }),
        ...(args.includes('--stale') ? { stale: true } : {}),
        ...(args.includes('--failed') ? { failed: true } : {}),
      });
      const items = listings.map(item => ({ ...item.record, freshness: item.freshness, ...(item.recovery ? { recovery: item.recovery } : {}) }));
      if (json) { print({ change: id, evidence: items }); }
      else {
        const lines: string[] = [section(`Evidence: ${id}`)];
        if (!items.length) lines.push(warn('No evidence matched.'));
        else {
          const rows = listings.map(item => {
            const links = [
              ...(item.record.checkIds?.length ? [`check ${item.record.checkIds.join(',')}`] : []),
              ...(item.record.requirementIds.length ? [`req ${item.record.requirementIds.join(',')}`] : []),
              ...(item.record.taskIds.length ? [`task ${item.record.taskIds.join(',')}`] : []),
            ];
            return [
              item.record.id.slice(0, 8),
              item.record.kind,
              item.record.outcome,
              item.freshness.status,
              item.freshness.basis,
              links.join('; ') || '(none)',
              item.record.capturedAt,
              item.record.summary.split(/\r?\n/)[0].slice(0, 50),
            ];
          });
          lines.push(table(['ID', 'Kind', 'Outcome', 'Freshness', 'Basis', 'Links', 'Captured', 'Summary'], rows));
          for (const item of listings) {
            if (item.freshness.reasons.length) lines.push(bullet(`${item.record.id.slice(0, 8)} ${item.freshness.status}: ${item.freshness.reasons.join(' ')}`));
            if (item.recovery) lines.push(bullet(`Recovery for ${item.record.id.slice(0, 8)}: ${item.recovery}`));
          }
        }
        console.log(box(lines));
      }
    }
    else if (command === 'backlog' && positional[1] === 'import') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('backlog import', `notchlet backlog import <item-key|title|id> [--product-id <id>]

  Import a backlog item as a change.

Options:
  <item-key|title|id>  Backlog key, title, or numeric ID
  --product-id <id>    Product ID (defaults to the workspace binding)
  --server <url>     Notchlet server (default: ${DEFAULT_SERVER})
  --endpoint <url>   Override MCP endpoint
  --allow-file-token-store   Allow restricted file credential storage
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('backlog import');
      const itemQuery = positional[2] ?? (isTty() ? await prompt('Backlog item key or title: ') : undefined);
      if (!itemQuery) fail('usage_error', usage, 'Provide a backlog key/title/ID, for example `APP-42` or `Improve onboarding`.', 64);
      let productId = Number(optionValue('--product-id'));
      if (!Number.isSafeInteger(productId) || productId < 1) {
        try { productId = Number(JSON.parse(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8')).binding?.productId); }
        catch { productId = NaN; }
      }
      if (!Number.isSafeInteger(productId) || productId < 1) fail('product_required', 'No product is selected for this workspace.', 'Run `notchlet init` or `notchlet workspace bind`, or pass --product-id.', 64);
      let itemId = Number(itemQuery);
      if (!Number.isSafeInteger(itemId) || itemId < 1) {
        const { platformApi } = await import('./integration.js');
        const api = await platformApi(optionValue('--server'), { allowFileStore: args.includes('--allow-file-token-store') });
        const items = await api.get(`/backlog?productId=${productId}`) as any[];
        const selected = await pickNamedValue(itemQuery, items, {
          kind: 'Backlog item', promptText: 'Select backlog item',
          label: item => `${item.key ? `${item.key} · ` : ''}${item.title} · ${item.status ?? item.itemType ?? 'item'} (#${item.id})`,
          keys: item => [item.key, item.title, String(item.id)].filter(Boolean),
        });
        if (!selected) fail('backlog_item_not_found', `No backlog item matched "${itemQuery}" in product ${productId}.`, 'Check the item key/title or select the correct product with --product-id.', 2);
        itemId = Number(selected.id);
      }
      if (!Number.isSafeInteger(itemId) || itemId < 1) fail('usage_error', usage, 'Provide a valid backlog key, title, or numeric ID.', 64);
      const { importBacklogItem } = await import('./integration.js');
      const change = await importBacklogItem(root, { itemId, productId, server: optionValue('--server'), endpoint: optionValue('--endpoint'), allowFileStore: args.includes('--allow-file-token-store') });
      printWithSync({ change }, await syncIfAutomatic(root, change.id), `Imported backlog item ${itemId} as change ${change.id}.`);
    }
    else if (command === 'mcp') {
      const action = positional[1];
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('mcp', `notchlet mcp <action> [options]

  serve      Run the local MCP server. Use --local for offline work; --server for the stdio bridge
  configure  Create a credential and write project MCP configuration for a coding agent
  status     Show MCP setup, credential presence, and project config state
  token      Print the stored credential for manual environment setup (secret)
  disconnect Remove this project's Notchlet MCP entry (and optionally revoke)
  revoke     Revoke the generated MCP credential and delete its local secret

Syntax:
  notchlet mcp serve --local
  notchlet mcp serve --server <url>
  notchlet mcp configure --client <agent> [--transport bridge|remote|local]
  notchlet mcp status [--server <url>]
  notchlet mcp token [--server <url>]
  notchlet mcp disconnect [--client <agent>]
  notchlet mcp revoke [--server <url>]

Options:
  --server <url>         Notchlet server (default: ${DEFAULT_SERVER})
  --local                Offline MCP server backed by this workspace (serve, configure)
  --transport <mode>     bridge (stdio, default), remote (direct HTTP), or local (configure)
  --token-env <name>     Environment variable for a remote entry (default NOTCHLET_MCP_TOKEN)
  --scope-preset <name>  recommended (default) or broader (configure)
  --client <name>        Coding agent (opencode, claude)
  --credential-id <id>   Credential to revoke (revoke)
  --revoke               Also revoke the account credential (disconnect)
  --yes                  Skip confirmation prompts
  --workspace <root>     Set workspace root (serve, status, token, disconnect, revoke)
  --json                 Machine-readable JSON output (status/token/disconnect/revoke/configure)

The stdio bridge and local server read credentials from the OS credential store.
Remote entries reference the token through an environment variable, never inline; print it with \`notchlet mcp token\`.`);
      }
      const clientOption = optionValue('--client');
      if (clientOption !== undefined && !['opencode', 'claude'].includes(clientOption)) fail('usage_error', usage, 'Use --client opencode or --client claude (currently supported).', 64);
      const client = clientOption as 'opencode' | 'claude' | undefined;
      if (action === 'serve') {
        const { redactMcpText } = await import('./mcp-bridge.js');
        try {
          if (args.includes('--local')) {
            const { serveLocalMcp } = await import('./mcp-local.js');
            await serveLocalMcp({ workspace: optionValue('--workspace') ?? explicitRoot });
          } else {
            const { serveMcp } = await import('./mcp-bridge.js');
            await serveMcp(serverOption(), { client, workspace: optionValue('--workspace') ?? explicitRoot });
          }
        } catch (error) {
          process.stderr.write(`notchlet mcp serve: ${redactMcpText(error instanceof Error ? error.message : String(error))}\n`);
          process.exitCode = 1;
        }
      } else if (action === 'configure') {
        if (!client) fail('usage_error', usage, 'Provide --client opencode or --client claude for MCP configuration.', 64);
        const transportOption = optionValue('--transport');
        const transport = transportOption ?? (args.includes('--local') ? 'local' : args.includes('--remote') ? 'remote' : 'bridge');
        if (!['bridge', 'remote', 'local'].includes(transport)) fail('usage_error', usage, 'Use --transport bridge, remote, or local.', 64);
        const root = await requireWorkspace('mcp configure');
        const { mcpClientLabel, setupLocalMcpAccess, setupMcpAccess } = await import('./mcp-onboarding.js');
        const scopeOption = optionValue('--scope-preset');
        if (scopeOption !== undefined && !['recommended', 'broader'].includes(scopeOption)) fail('usage_error', usage, 'Use --scope-preset recommended or broader.', 64);
        let result;
        if (transport === 'local') {
          result = await setupLocalMcpAccess({ root, client });
        } else {
          const yes = args.includes('--yes');
          result = await setupMcpAccess({
            root,
            server: serverOption(),
            client,
            transport: transport as 'bridge' | 'remote',
            tokenEnv: optionValue('--token-env'),
            scopePreset: scopeOption as 'recommended' | 'broader' | undefined,
            allowFileStore: args.includes('--allow-file-token-store'),
            confirmEnable: async (message) => {
              if (yes) return true;
              if (!isTty()) return false;
              return confirm(message);
            },
          });
          if (result.status === 'declined' && !yes && !isTty()) fail('confirmation_required', 'Enabling account MCP access requires confirmation.', 'Pass --yes to approve account-wide MCP enablement in non-interactive mode.', 64);
        }
        if (json) { print(result); }
        else {
          const lines: string[] = [section('MCP configured')];
          lines.push(kv('Client', mcpClientLabel(client)));
          lines.push(kv('Transport', result.transport));
          lines.push(kv('Config', result.configPath ?? '(none)'));
          if (result.credentialName) lines.push(kv('Credential', result.credentialName));
          if (result.scopes?.length) lines.push(kv('Scopes', result.scopes.join(', ')));
          if (result.status === 'configured') lines.push(kv('Verification', ok(`${result.toolCount ?? 0} tools`)));
          else lines.push(kv('Verification', warn(result.status)));
          if (result.tokenEnv) lines.push(kv('Token env', `${result.tokenEnv} (set it in the environment that starts ${mcpClientLabel(client)})`));
          if (result.message) lines.push(kv('Note', warn(result.message)));
          console.log(box(lines));
          if (result.status === 'conflict' || result.status === 'declined') process.exitCode = 1;
        }
      } else if (action === 'status') {
        const root = await workspace();
        const { mcpStatus, mcpClientLabel } = await import('./mcp-onboarding.js');
        const result = await mcpStatus({ root, server: optionValue('--server'), client });
        if (json) { print(result); }
        else {
          const lines: string[] = [section('MCP status')];
          lines.push(kv('Workspace', result.root ?? '(none)'));
          if (!result.servers.length) lines.push(warn('No MCP configuration is recorded for this workspace. Run `notchlet init --interactive` to configure it.'));
          for (const server of result.servers) {
            const localTransport = server.transport === 'local';
            lines.push(divider());
            lines.push(kv('Server', server.server));
            lines.push(kv('Transport', server.transport));
            if (!localTransport) {
              if (server.credential) {
                lines.push(kv('Credential', `${server.credential.name}${server.credential.id ? ` (id ${server.credential.id})` : ''}`));
                lines.push(kv('Scopes', server.credential.scopes.join(', ') || '(none)'));
                lines.push(kv('Keyring', server.credential.keyring === 'present' ? ok('present') : server.credential.keyring === 'missing' ? err('missing') : warn('unavailable')));
              } else {
                lines.push(kv('Credential', warn('none recorded')));
              }
              if (server.account) {
                const account = server.account.enabled === true ? ok('enabled') : server.account.enabled === false ? warn('disabled') : warn(`unknown${server.account.error ? ` - ${server.account.error}` : ''}`);
                lines.push(kv('Account MCP', account));
              }
            }
            for (const entry of server.clients) {
              const state = entry.state === 'configured' ? ok('configured') : entry.state === 'modified' ? warn('modified (preserved)') : entry.state === 'invalid' ? err('invalid') : warn('missing');
              lines.push(kv(mcpClientLabel(entry.client), `${state} - ${entry.path}${entry.reason ? ` (${entry.reason})` : ''}`));
            }
            if (localTransport) lines.push(kv('Note', 'The local transport runs offline and requires no remote credential.'));
          }
          console.log(box(lines));
        }
      } else if (action === 'disconnect') {
        const root = await requireWorkspace('mcp disconnect');
        const yes = args.includes('--yes');
        if (!yes && !isTty()) fail('confirmation_required', 'MCP disconnect changes project configuration and requires confirmation.', 'Pass --yes to confirm in non-interactive mode.', 64);
        const { mcpDisconnect, mcpClientLabel } = await import('./mcp-onboarding.js');
        const result = await mcpDisconnect({
          root,
          server: optionValue('--server'),
          client,
          revoke: args.includes('--revoke'),
          yes,
          confirm: (message) => confirm(message),
          allowFileStore: args.includes('--allow-file-token-store'),
        });
        if (json) { print(result); }
        else {
          const lines: string[] = [section('MCP disconnect')];
          if (result.message) lines.push(warn(result.message));
          for (const entry of result.removed) {
            const state = entry.action === 'removed' ? ok('removed') : entry.action === 'conflict' ? err('conflict') : warn('not configured');
            lines.push(kv(mcpClientLabel(entry.client), `${state} - ${entry.path}${entry.reason ? ` (${entry.reason})` : ''}`));
          }
          if (result.credential) {
            lines.push(kv('Credential', `${result.credential.name}${result.credential.id ? ` (id ${result.credential.id})` : ''}`));
            lines.push(kv('Revoked', result.credential.revoked ? ok('yes') : warn('no')));
            lines.push(kv('Keyring', result.credential.keyring === 'removed' ? ok('removed') : result.credential.keyring === 'missing' ? warn('missing') : warn('kept')));
            if (result.credential.message) lines.push(kv('Note', warn(result.credential.message)));
          }
          console.log(box(lines));
        }
      } else if (action === 'token') {
        const root = await requireWorkspace('mcp token');
        const { mcpToken } = await import('./mcp-onboarding.js');
        const result = await mcpToken({ root, server: optionValue('--server') });
        if (json) { print(result); }
        else {
          process.stderr.write(`MCP credential for ${result.origin} (${result.credentialName}). Treat this value as a secret and set it in the client environment, for example:\n  export NOTCHLET_MCP_TOKEN="$(notchlet mcp token --server ${result.origin})"\n`);
          console.log(result.token);
        }
      } else if (action === 'revoke') {
        const root = await workspace();
        const yes = args.includes('--yes');
        if (!yes && !isTty()) fail('confirmation_required', 'MCP credential revocation requires confirmation.', 'Pass --yes to confirm in non-interactive mode.', 64);
        const { mcpRevoke } = await import('./mcp-onboarding.js');
        const rawId = optionValue('--credential-id');
        const credentialId = rawId === undefined ? undefined : Number(rawId);
        if (credentialId !== undefined && (!Number.isSafeInteger(credentialId) || credentialId < 1)) fail('usage_error', usage, 'Provide a numeric --credential-id.', 64);
        const result = await mcpRevoke({
          root,
          server: optionValue('--server'),
          credentialId,
          yes,
          confirm: (message) => confirm(message),
          allowFileStore: args.includes('--allow-file-token-store'),
        });
        if (json) { print(result); }
        else {
          const lines: string[] = [section('MCP credential revoked')];
          lines.push(kv('Server', result.origin));
          if (result.credentialName) lines.push(kv('Credential', `${result.credentialName}${result.credentialId ? ` (id ${result.credentialId})` : ''}`));
          lines.push(kv('Remote revocation', result.revoked ? ok('revoked') : warn('already revoked or not found')));
          lines.push(kv('Keyring', result.keyring === 'removed' ? ok('removed') : result.keyring === 'missing' ? warn('missing') : warn('kept')));
          if (result.message) lines.push(kv('Note', warn(result.message)));
          console.log(box(lines));
        }
      } else fail('usage_error', usage, 'Use `notchlet mcp serve|configure|status|token|disconnect|revoke`.', 64);
    }
    else if (command === 'init') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('init', `notchlet init [path] [--local|--interactive]

  Initialize a Notchlet workspace in the given path (or current directory).

Options:
  --local              Initialize local-only mode (no account login)
  --interactive        Force interactive setup (prompts for server, org, product, repository)
  --client <name>      Also install skills and local MCP config (opencode, claude)
  --remote             With --interactive: write a direct remote MCP entry instead of the stdio bridge
  --workspace <root> / --root <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = path.resolve(positional[1] ?? explicitRoot ?? process.cwd());
      if (args.includes('--interactive') && json) fail('usage_error', usage, 'Interactive setup cannot be combined with --json.', 64);
      const interactive = args.includes('--interactive') || (!args.includes('--local') && !json && Boolean(process.stdin.isTTY && process.stderr.isTTY));
      if (interactive) {
        const { interactiveInit } = await import('./setup.js');
        const result = await interactiveInit(root, args.includes('--remote') ? { transport: 'remote' } : {});
        if (json) { print(result); }
        else {
          const lines: string[] = [];
          lines.push(section('Workspace initialized'));
          lines.push(kv('Root', result.root));
          lines.push(kv('Mode', result.mode));
          if (result.accountConnected) lines.push(kv('Account connected', 'yes'));
          if (result.organizationId) lines.push(kv('Organization ID', String(result.organizationId)));
          if (result.productId) lines.push(kv('Product ID', String(result.productId)));
          if (result.syncMode) lines.push(kv('Sync mode', result.syncMode));
          if (result.guidance) {
            const guidance = result.guidance as { client: string; results: Array<{ applied: boolean; action: string }> };
            const applied = guidance.results.filter(item => item.applied).length;
            const conflicts = guidance.results.filter(item => item.action === 'conflict').length;
            const clientName = guidance.client === 'opencode' ? 'OpenCode' : 'Claude Code';
            lines.push(kv('Agent skills', `${applied} installed for ${clientName}${conflicts ? `; ${conflicts} conflict(s) preserved` : ''}`));
          }
          if (result.mcp) {
            const mcp = result.mcp;
            const clientName = mcp.client === 'opencode' ? 'OpenCode' : 'Claude Code';
            const state = mcp.status === 'configured'
              ? ok(`configured for ${clientName}${typeof mcp.toolCount === 'number' && mcp.toolCount > 0 ? ` (${mcp.toolCount} tools verified)` : ''}`)
              : mcp.status === 'configured-unverified'
                ? warn(`written for ${clientName}; live verification failed${mcp.message ? ` - ${mcp.message}` : ''}`)
                : mcp.status === 'conflict'
                  ? err(`conflict for ${clientName}${mcp.message ? ` - ${mcp.message}` : ''}`)
                  : warn(`skipped for ${clientName}${mcp.message ? ` - ${mcp.message}` : ''}`);
            lines.push(kv('MCP access', state));
          }
          if (result.message) lines.push(kv('Message', result.message));
          if (result.binding) {
            lines.push(divider());
            lines.push(section('Binding'));
            // interactiveInit wraps bindWorkspace's result, which itself wraps
            // the persisted binding together with rebound/alreadyBound metadata.
            const bindingResult = result.binding as any;
            const b = bindingResult.binding ?? bindingResult;
            lines.push(kv('Server', b.server));
            lines.push(kv('Product ID', String(b.productId)));
            lines.push(kv('Repository ID', String(b.repositoryId)));
            lines.push(kv('Repository remote', b.repositoryRemote));
          }
          console.log(box(lines));
        }
      }
      else {
        await initWorkspace(root);
        const localGuidance = await writeWorkspaceGuidance(root);
        const clientOption = optionValue('--client');
        if (clientOption !== undefined && !['opencode', 'claude'].includes(clientOption)) fail('usage_error', usage, 'Use --client opencode or --client claude.', 64);
        let guidance: Awaited<ReturnType<typeof import('./guidance-install.js').installClientGuidance>> | undefined;
        let mcp: Awaited<ReturnType<typeof import('./mcp-onboarding.js').setupLocalMcpAccess>> | undefined;
        if (clientOption) {
          const { installClientGuidance } = await import('./guidance-install.js');
          guidance = await installClientGuidance(root, clientOption as 'opencode' | 'claude', { apply: true });
          if (args.includes('--local')) {
            const { setupLocalMcpAccess } = await import('./mcp-onboarding.js');
            mcp = await setupLocalMcpAccess({ root, client: clientOption as 'opencode' | 'claude' });
          }
        }
        const data = { root, initialized: true, mode: 'local', localGuidance, ...(guidance ? { guidance } : {}), ...(mcp ? { mcp } : {}) };
        if (json) { print(data); }
        else {
          const lines: string[] = [section('Workspace initialized'), kv('Root', root), kv('Mode', 'local')];
          lines.push(kv('Local guidance', `${localGuidance.written.length} written${localGuidance.existing.length ? `, ${localGuidance.existing.length} preserved` : ''}`));
          if (localGuidance.written.length) lines.push(kv('Guidance files', localGuidance.written.join(', ')));
          if (guidance) lines.push(kv('Agent skills', `${guidance.results.filter(item => item.applied).length} installed for ${clientOption === 'claude' ? 'Claude Code' : 'OpenCode'}`));
          if (mcp) lines.push(kv('MCP', mcp.status === 'configured' ? ok(`local server configured${typeof mcp.toolCount === 'number' ? ` (${mcp.toolCount} tools)` : ''}`) : warn(`${mcp.status}${mcp.message ? ` - ${mcp.message}` : ''}`)));
          console.log(box(lines));
        }
      }
    } else if (command === 'change') {
      const action = positional[1];
      if (args.includes('--help') || args.includes('-h')) {
        const helpKind = positional.slice(2).find(isChangeKind);
        if ((action === 'add' || action === 'update') && isChangeKind(helpKind)) showCommandHelp(`change ${action} ${helpKind}`, changeItemHelp(action, helpKind));
        showCommandHelp('change', `notchlet change <action> [options]

  new <name> [--quick] [--from <plan.json> [--dry-run] [--no-render]]
                                 Create a change, optionally importing a declarative plan
  list [--archived]              List active changes, or archived changes with --archived
  show <name|id>                 Show change details, content, capability, and readiness
  path <name|id> [artifact]      Print the resolved change directory or declared artifact path
  restore <name|id>              Move an archived change back to active work
  export <name|id> [--format json]   Export change metadata, closure, evidence, and artifacts
  update <name|id> <kind> <id> [fields]   Edit one authored item in place
  update <name|id> [options]     Update change fields, including run and verification metadata
  add <name|id> <kind> [options] Add a requirement, check, scenario, decision, or task
  remove <name|id> <kind> <id> [--revision <n>]   Remove an authored item
  convert <name|id> --schema <q|s> [--revision <n>] Convert a change schema
  apply <name|id> --file <path> [--revision <n>]  Apply an ordered batch of authoring operations
  render <name|id> [--check|--write] [--force]    Render model-derived proposal/spec/tasks artifacts
  baseline <name|id> [--capability <name>] [--revision <n>]
                                 Capture the current capability baseline revision
  delta <name|id> add|update|remove|delete --requirement <id> [--rationale <text>]
                                 Author or delete an explicit capability delta operation
  plan validate <path>           Validate a change plan without importing it
  plan status <name|id>          Show plan provenance, drift, validation, and contract SHA-256 (archived read-only)
  plan sync <name|id>            Accept the current plan file hash after reviewing drift
  close <name|id> --preview | [--baseline-revision <n>]   Close and archive a change

Authored content options:
  --id <id> --title <text> --description <text>        Requirement/task/check fields
  --command <cmd>                                       Executable command for a check
  --kind command|http|browser|ui|manual                     Check execution kind (browser remains an HTTP alias)
  --url <url> --expected-status <code>                   HTTP check target and expected status
  --expected-body-contains <text> --expected-json <json> HTTP body and JSON subset assertions
  --expected-json-contains <json>                        HTTP JSON containment (extra/items unordered allowed)
  --expected-json-at <json>                              HTTP JSON path assertions: {"path":"$.total","gte":100}
  --expected-header "Name: value"                        Expected HTTP response header (repeatable)
  --working-directory <dir>                              Workspace-relative command working directory
  --requirement <id[,id]>                               Requirement ID(s) for a scenario/task/check
  --scenario <id[,id]>                                  Scenario ID(s) linked to a check
  --task <id[,id]>                                      Task ID(s) linked to a check
  --when <text> --then <text>                           Acceptance scenario statements
  --decision <text> --rationale <text>                  Design decision fields
  --depends-on <id[,id]>                                Task dependency IDs
  --intent <text> --outcome <text>                      Change intent/outcome updates
  --capability-name <text> --capability-impact none|delta --capability-rationale <text>
  --run-command <cmd> --preview-url <url> --readiness-url <url>   Run metadata surfaced in instructions
  --ready-timeout <ms> --ready-interval <ms>            Optional readiness polling during verify
  --environment KEY=value                                Reproducible environment variable (repeatable)
  --setup <cmd> --teardown <cmd>                        Commands to run around verification
  --coverage-policy advisory|strict                      Whether unlinked requirements/scenarios block planning
  --revision <n>                                        Expected change revision; rejects a stale write

  Set local run metadata without editing \`tasks.json\`:
    notchlet change update <change> --run-command "node server.mjs" --readiness-url "http://127.0.0.1:3000/health" \\
      --ready-timeout 20000 --environment PORT=3000 --setup "node seed.mjs"
  Hand-editing authored state bypasses the model and reports authored artifact drift; execution metadata edits are reported as execution drift without advancing the revision.

Options:
  --quick                  Create a quick (minimal) change
  --from <path>            JSON change plan to import during \`change new\`
  --dry-run                Preview a plan import without writing files
  --render                 Render canonical artifacts during plan import (default)
  --no-render              Import only plan-provided artifact contents
  --markdown               Also declare and render optional proposal.md/spec.md/tasks.md views
  --schema quick|standard  Schema for conversion (required for convert)
  --file <path>            JSON batch file with expectedRevision and ordered operations (apply)
  --check                  Report artifact drift without writing (render)
  --write                  Atomically write rendered artifacts and bump the revision once (render)
  --force                  Overwrite artifacts without the generated-content marker (render)
  --preview                Preview closure without changing files (for close)
  --baseline-revision <n>  Expected baseline revision for close (standard and delta changes only)
  --accept-plan-drift      Close despite source-plan drift, a missing plan, or plan validation errors
  --yes                    Skip confirmation prompt (for close)
  --archived               Select archived changes (list)
  --format json            Export format (export)
  --workspace <root>       Set workspace root
  --json                   Machine-readable JSON output`);
      }
      if (action === 'new') {
        assertOptions(['--quick', '--from', '--dry-run', '--render', '--no-render', '--markdown'], 'change new');
        if ((args.includes('--dry-run') || args.includes('--render') || args.includes('--no-render') || args.includes('--markdown')) && !optionValue('--from')) fail('usage_error', '--dry-run, --render, --no-render, and --markdown require --from <path>.', 'Run `notchlet change new <name> --from plan.json --dry-run`.', 64);
        if (args.includes('--render') && args.includes('--no-render')) fail('usage_error', 'Choose either --render or --no-render.', 'Plan import renders canonical artifacts by default; pass --no-render to disable it.', 64);
        const renderPlanArtifacts = !args.includes('--no-render');
        const planPath = optionValue('--from');
        if (planPath) {
          const planFile = await resolvePlanPath(await workspace(), planPath);
          let text: string;
          try { text = await readFile(planFile, 'utf8'); }
          catch (error) { fail('plan_not_found', `Could not read change plan: ${planPath}.`, 'Provide a readable JSON plan file path after --from.', 1); }
          let planValue: unknown;
          try { planValue = JSON.parse(text) as unknown; }
          catch { fail('malformed_plan', 'Change plan is not valid JSON.', 'Repair the plan file syntax and try again.', 1); }
          const plan = parseChangePlan(planValue);
          // The positional name overrides the plan name so a plan can be dry-run under an alias.
          const name = positional[2] ?? plan.name;
          if (!name) fail('usage_error', 'Provide a change name or include "name" in the plan.', 'Run `notchlet change new <name> --from plan.json`.', 64);
          const mode = args.includes('--quick') ? 'quick' : plan.mode;
          if (args.includes('--dry-run')) {
            const markdown = args.includes('--markdown');
            const render = renderPlanArtifacts || markdown;
            const projected = projectChangePlan(name, plan, { ...(mode ? { mode } : {}) });
            const previewChange = markdown ? withMarkdownArtifacts(projected.change) : projected.change;
            const renderedArtifacts = render ? renderChangeArtifacts(previewChange) : [];
            const renderedContents = Object.fromEntries(renderedArtifacts.map(artifact => [artifact.path, artifact.content]));
            const writes = render ? { ...plan.artifactContents, ...renderedContents } : plan.artifactContents;
            const planReadiness = readiness(previewChange, { ...plan.artifactContents, ...(render ? renderedContents : {}) });
            const postImport = previewPlanReadiness(previewChange, { ...plan.artifactContents, ...(render ? renderedContents : {}) }, { render });
            const declared = Object.entries(previewChange.artifacts)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([artifact, relative]) => {
                const content = writes[relative] ?? renderedContents[relative];
                return {
                  artifact,
                  path: relative,
                  role: artifactRole(artifact),
                  fullPath: ['.notchlet', 'changes', projected.change.id, relative].join('/'),
                  ...(content === undefined ? {} : { bytes: Buffer.byteLength(content) }),
                };
              });
            print({
              dryRun: true, change: previewChange,
              artifacts: declared,
              contents: writes,
              readiness: planReadiness,
              postImport,
            }, [
              section('Change plan preview'),
              kv('Name', projected.change.name),
              kv('ID', projected.change.id),
              kv('Mode', projected.change.mode),
              kv('Capability contribution', postImport.contribution),
              kv('Requirements', String(projected.change.requirements.length)),
              kv('Tasks', String(projected.change.tasks.length)),
              kv('Checks', String(projected.change.checks.length)),
              kv('Declared artifacts', declared.map(artifact => `${artifact.artifact} [${artifact.role}] -> ${artifact.fullPath}`).join(', ') || '(none)'),
              kv('Renderable artifacts', renderedArtifacts.map(artifact => `${artifact.path} [${artifactRole(artifact.artifact)}]`).join(', ') || '(none)'),
              kv('Ready now', planReadiness.ready ? ok('yes') : warn(`no (${planReadiness.blockers.length} blocker${planReadiness.blockers.length === 1 ? '' : 's'})`)),
              ...planReadiness.blockers.map(blocker => bullet(`${blocker.code}: ${blocker.message}`)),
              section('Required after import'),
              ...(postImport.setup.length ? postImport.setup.flatMap(step => [bullet(`${step.code}: ${step.message}`), bullet(step.command, '↳')]) : [bullet(ok('No setup steps remain.'))]),
              kv('Planning ready after setup', postImport.readyAfterSetup ? ok('yes') : warn(`no (${postImport.remainingBlockers.length} unresolved)`)),
              bullet(warn('Runtime readiness is not checked during dry-run; verify polls it only when readyTimeoutMs is declared.')),
              ...postImport.remainingBlockers.map(blocker => bullet(`${blocker.code}: ${blocker.message}`)),
            ].join('\n'));
            return;
          }
          const root = await requireWorkspace('change new');
          const change = await scaffold(root, name, mode ?? 'standard');
          const markdown = args.includes('--markdown');
          const relativePlan = path.relative(path.resolve(root), planFile).split(path.sep).join('/');
          const sourcePlan = relativePlan && !relativePlan.startsWith('..') && !path.isAbsolute(relativePlan)
            ? { path: relativePlan, sha256: createHash('sha256').update(text).digest('hex'), importedAt: new Date().toISOString() }
            : undefined;
          const imported = await importChangePlan(root, change.id, plan, { render: renderPlanArtifacts || markdown, markdown, name, ...(sourcePlan === undefined ? {} : { sourcePlan }) });
          const evidenceAdvisory = imported.change.evidencePolicy === undefined
            ? {
              code: 'evidence_policy_default',
              message: 'No evidencePolicy was declared; the default per-task policy warns when tasks complete before evidence exists.',
              recovery: `Use --evidence-policy end-of-change when one final verification batch covers all tasks, or persist it with \`notchlet change update ${imported.change.id} --evidence-policy end-of-change\`.`,
              options: { perTask: 'Warn at each task completion.', endOfChange: 'Suppress per-task warnings; closure still requires current checks.' },
            }
            : undefined;
          printWithSync(
            { ...imported.change, import: { written: imported.written, rendered: imported.rendered }, ...(evidenceAdvisory === undefined ? {} : { advisory: evidenceAdvisory }) },
            await syncIfAutomatic(root, imported.change.id),
            `Created change ${imported.change.id}: ${imported.change.name} from plan (${imported.written.length} artifact${imported.written.length === 1 ? '' : 's'} written).${evidenceAdvisory === undefined ? '' : `\nAdvisory: ${evidenceAdvisory.message} ${evidenceAdvisory.recovery}`}`,
          );
        } else {
          const name = positional[2] ?? (isTty() ? await prompt('Change name: ') : undefined);
          if (!name) fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
          const root = await requireWorkspace('change new');
          const change = await scaffold(root, name, args.includes('--quick') ? 'quick' : 'standard');
          const evidenceAdvisory = change.evidencePolicy === undefined
            ? {
              code: 'evidence_policy_default',
              message: 'No evidencePolicy was declared; the default per-task policy warns when tasks complete before evidence exists.',
              recovery: `Use --evidence-policy end-of-change when one final verification batch covers all tasks, or persist it with \`notchlet change update ${change.id} --evidence-policy end-of-change\`.`,
              options: { perTask: 'Warn at each task completion.', endOfChange: 'Suppress per-task warnings; closure still requires current checks.' },
            }
            : undefined;
          printWithSync({ ...change, ...(evidenceAdvisory === undefined ? {} : { advisory: evidenceAdvisory }) }, await syncIfAutomatic(root, change.id), `Created change ${change.id}: ${change.name}.${evidenceAdvisory === undefined ? '' : `\nAdvisory: ${evidenceAdvisory.message} ${evidenceAdvisory.recovery}`}`);
        }
      } else if (action === 'restore') {
        assertOptions([], 'change restore');
        const root = await requireWorkspace('change restore');
        const changeRef = positional[2];
        if (!changeRef) fail('usage_error', usage, 'Use `notchlet change restore <change>`.', 64);
        const target = await resolveChangeTarget(root, changeRef);
        if (!target.archived) fail('change_exists', `Change ${target.id} is already active.`, 'Use `notchlet change show` to inspect the active change.', 1);
        const change = await restoreChange(root, target.id);
        printWithSync(change, await syncIfAutomatic(root, change.id), `Restored change ${change.id}: ${change.name}.`);
      } else if (action === 'path') {
        assertOptions([], 'change path');
        const root = await requireWorkspace('change path');
        const changeRef = positional[2];
        if (!changeRef) fail('usage_error', usage, 'Use `notchlet change path <change> [artifact]`.', 64);
        const target = await resolveChangeTarget(root, changeRef);
        const change = target.archived ? await readArchivedChange(root, target.id) : await readChange(root, target.id);
        const artifact = positional[3];
        const relativeDirectory = ['.notchlet', target.archived ? 'archive' : 'changes', target.id].join('/');
        let relative = relativeDirectory;
        if (artifact !== undefined) {
          if (!Object.prototype.hasOwnProperty.call(change.artifacts, artifact)) {
            fail('unknown_artifact', `Artifact ${artifact} is not declared on ${change.id}.`, `Use one of: ${Object.keys(change.artifacts).sort().join(', ')}.`, 2);
          }
          relative = [relativeDirectory, change.artifacts[artifact]].join('/');
        }
        const data = { changeId: change.id, archived: target.archived, ...(artifact === undefined ? {} : { artifact, role: artifactRole(artifact) }), path: relative, absolutePath: path.join(root, ...relative.split('/')) };
        print(data, [kv('Change', change.id), ...(artifact === undefined ? [] : [kv('Artifact', `${artifact} [${artifactRole(artifact)}]`)]), kv('Path', relative), kv('Absolute', path.join(root, ...relative.split('/')))].join('\n'));
      } else if (action === 'export') {
        assertOptions(['--format'], 'change export');
        const format = optionValue('--format') ?? 'json';
        if (format !== 'json') fail('usage_error', 'Only `--format json` is supported.', 'Run `notchlet change export <change> --format json`.', 64);
        const root = await requireWorkspace('change export');
        const changeRef = positional[2];
        if (!changeRef) fail('usage_error', usage, 'Use `notchlet change export <change> [--format json]`.', 64);
        const target = await resolveChangeTarget(root, changeRef);
        const change = target.archived ? await readArchivedChange(root, target.id) : await readChange(root, target.id);
        const [evidence, contents, artifactState, closure] = await Promise.all([
          readEvidence(root, target.id),
          artifactContents(root, target.id, change, { archived: target.archived }),
          inspectChangeArtifacts(root, target.id),
          target.archived ? readArchivedClosure(root, target.id) : Promise.resolve(undefined),
        ]);
        const closureView = target.archived ? await readFile(path.join(root, '.notchlet', 'archive', target.id, 'closure.md'), 'utf8').catch(() => undefined) : undefined;
        const exported = { change, archived: target.archived, ...(closure ? { closure } : {}), ...(closureView === undefined ? {} : { closureView }), evidence, artifacts: artifactState.artifacts, contents };
        const evidenceFiles: Array<{ evidenceId: string; role: 'log' | 'attachment'; path: string; sha256: string; bytes: number; mediaType?: string; encoding: 'utf8' | 'base64'; content: string }> = [];
        for (const record of evidence) {
          if (record.logPath) {
            const absolute = record.logPath.startsWith('evidence/') ? await evidenceAssetPath(root, target.id, record.logPath) : path.resolve(root, record.logPath);
            const buffer = await readFile(absolute).catch(() => undefined);
            if (buffer) evidenceFiles.push({ evidenceId: record.id, role: 'log', path: record.logPath, sha256: record.logHash ?? '', bytes: buffer.byteLength, mediaType: 'application/json', encoding: 'utf8', content: buffer.toString('utf8') });
          }
          for (const attachment of record.attachments ?? []) {
            const absolute = await evidenceAssetPath(root, target.id, attachment.path);
            const buffer = await readFile(absolute).catch(() => undefined);
            if (!buffer) continue;
            const textual = attachment.kind === 'dom' || attachment.kind === 'text' || attachment.kind === 'json' || attachment.mediaType === undefined || attachment.mediaType.startsWith('text/') || attachment.mediaType === 'application/json';
            evidenceFiles.push({ evidenceId: record.id, role: 'attachment', path: attachment.path, sha256: attachment.sha256, bytes: buffer.byteLength, ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }), encoding: textual ? 'utf8' : 'base64', content: buffer.toString(textual ? 'utf8' : 'base64') });
          }
        }
        if (json) { print({ ...exported, evidenceFiles }); }
        else console.log(JSON.stringify({ ...exported, evidenceFiles }, null, 2));
      } else if (action === 'list') {
        assertOptions(['--archived'], 'change list');
        const root = await workspace();
        if (!root) { print({ changes: [] }, 'No Notchlet workspace found.'); }
        else {
          const archived = args.includes('--archived');
          const changes = archived ? await listArchivedChanges(root) : await listChanges(root);
          if (json) { print({ workspace: root, changes, ...(archived ? { archived: true } : {}) }); }
          else {
            console.log(section(`${archived ? 'Archived changes' : 'Changes'} in ${root}`));
            if (changes.length === 0) { console.log(warn('(none)')); }
            else if (archived) {
              const rows = (changes as Awaited<ReturnType<typeof listArchivedChanges>>).map(change => [change.id, change.name, change.mode, change.closedAt ?? '(no closure manifest)', change.verificationStatus ?? '-', change.contribution ?? '-', change.resultingRevision === undefined ? '-' : String(change.resultingRevision)]);
              console.log(table(['ID', 'Name', 'Mode', 'Closed', 'Verification', 'Contribution', 'Capability rev'], rows));
            }
            else {
              const rows = changes.map((c: any) => [c.id, c.name, String(c.taskCount ?? 0), c.ready ? ok('ready') : err('not ready')]);
              console.log(table(['ID', 'Name', 'Tasks', 'Ready'], rows));
            }
          }
        }
      } else if (action === 'show') {
        assertOptions(['--archived'], 'change show');
        const root = await requireWorkspace('change show');
        const changeRef = positional[2] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        const target = changeRef ? await resolveChangeTarget(root, changeRef) : undefined;
        if (!target) fail('usage_error', usage, 'Provide a change name or ID from `notchlet change list`.', 64);
        const change = target.archived ? await readArchivedChange(root, target.id) : await readChange(root, target.id);
        const contents = await artifactContents(root, target.id, change, { archived: target.archived });
        const readinessResult = readiness(change, contents);
        const closure = target.archived ? await readArchivedClosure(root, target.id) : undefined;
        const executionDrift = inspectExecutionDrift(change);
        const result = { change, archived: target.archived, executionDrift, ...(closure ? { closure } : {}), readiness: readinessResult };
        if (json) { printWithSync(result, target.archived ? null : await syncIfAutomatic(root, target.id), undefined, executionDriftWarnings(target.id, executionDrift)); }
        else {
          const lines: string[] = [];
          lines.push(section(`Change: ${target.id}`));
          lines.push(kv('Name', change.name));
          lines.push(kv('Mode', change.mode));
          lines.push(kv('Archived', target.archived ? ok('yes') : 'no'));
          if (closure?.closedAt) lines.push(kv('Closed at', String(closure.closedAt)));
          if (closure) {
            const capabilityRecord = closure.capability as Record<string, unknown> | undefined;
            const verificationRecord = closure.verification as Record<string, unknown> | undefined;
            lines.push(kv('Capability contribution', String(closure.contribution ?? 'unknown')));
            lines.push(kv('Resulting capability revision', capabilityRecord?.resultingRevision === undefined ? '(none)' : String(capabilityRecord.resultingRevision)));
            lines.push(kv('Verification at close', String(verificationRecord?.status ?? 'unknown')));
            lines.push(kv('Closure manifest', `.notchlet/archive/${target.id}/closure.json`));
          }
          lines.push(kv('Revision', String(change.revision ?? 0)));
          lines.push(kv('Content revision', String(change.contentRevision ?? 0)));
          lines.push(kv('Evidence policy', change.evidencePolicy ?? 'per-task'));
          lines.push(kv('Intent', change.intent));
          lines.push(kv('Outcome', change.outcome));
          if (change.runCommand) lines.push(kv('Run command', change.runCommand));
          if (change.previewUrl) lines.push(kv('Preview URL', change.previewUrl));
          if (change.readinessUrl) lines.push(kv('Readiness probe', `${change.readinessUrl}${change.readyTimeoutMs === undefined ? ' (declared; polling disabled)' : ` (poll up to ${change.readyTimeoutMs}ms every ${change.readyIntervalMs ?? 250}ms)`}`));
          if (executionDrift.status === 'drifted') lines.push(kv('Execution metadata', err(`drifted since recorded — ${executionDrift.recovery}`)));
          lines.push(kv('Requirements', String(change.requirements.length)));
          lines.push(kv('Scenarios', String(change.acceptanceScenarios.length)));
          lines.push(kv('Decisions', String(change.designDecisions.length)));
          lines.push(kv('Checks', String(change.checks.length)));
          lines.push(kv('Tasks', String(change.tasks.length)));
          lines.push(divider());
          lines.push(section('Artifacts'));
          const artifactNames = Object.keys(change.artifacts).sort();
          const changeDirectory = ['.notchlet', target.archived ? 'archive' : 'changes', target.id].join('/');
          const closureArtifacts = closure?.artifacts as Array<{ artifact: string; path: string; role?: string; status?: string; bytes?: number }> | undefined;
          if (artifactNames.length === 0) lines.push(warn('(none)'));
          else if (closureArtifacts?.length) {
            lines.push(table(['Artifact', 'Path', 'Role', 'Status', 'Bytes'], closureArtifacts.map(artifact => [artifact.artifact, artifact.path, artifact.role ?? artifactRole(artifact.artifact), artifact.status ?? '-', artifact.bytes === undefined ? '-' : String(artifact.bytes)])));
          }
          else for (const name of artifactNames) lines.push(bullet(`${name} [${artifactRole(name)}]: ${changeDirectory}/${change.artifacts[name]}`));
          lines.push(divider());
          lines.push(section('Requirements'));
          if (change.requirements.length) {
            for (const requirement of change.requirements) {
              lines.push(bullet(`${requirement.id} [requirement] ${requirement.title}: ${requirement.description}`));
              const scenarios = change.acceptanceScenarios.filter(scenario => scenario.requirementId === requirement.id);
              if (scenarios.length) for (const scenario of scenarios) lines.push(bullet(`${scenario.id} [scenario] WHEN ${scenario.when} THEN ${scenario.then}`, '↳'));
              else lines.push(bullet('(no acceptance scenarios)', '↳'));
            }
          } else lines.push(warn('(none)'));
          for (const scenario of change.acceptanceScenarios.filter(item => !change.requirements.some(requirement => requirement.id === item.requirementId))) {
            lines.push(bullet(`${scenario.id} [scenario] references unknown requirement ${scenario.requirementId}`, '↳'));
          }
          lines.push(section('Design decisions'));
          if (change.designDecisions.length) for (const decision of change.designDecisions) lines.push(bullet(`${decision.id} [decision] ${sentence(decision.decision)}: ${sentence(decision.rationale)}`));
          else lines.push(warn('(none)'));
          lines.push(section('Checks'));
          if (change.checks.length) for (const check of change.checks) {
            const links = [
              ...(check.requirementIds?.length ? [`requirements ${check.requirementIds.join(', ')}`] : []),
              ...(check.taskIds?.length ? [`tasks ${check.taskIds.join(', ')}`] : []),
            ];
            const kind = check.kind ?? (check.command ? 'command' : check.url ? 'http' : 'manual');
            const assertions = [
              ...(check.expectedStatus === undefined ? [] : [`status ${check.expectedStatus}`]),
              ...(check.expectedBodyContains === undefined ? [] : [`body contains ${JSON.stringify(check.expectedBodyContains)}`]),
              ...(check.expectedJson === undefined ? [] : ['JSON subset']),
            ];
            const target = check.command ? ` -> ${check.command}` : check.url ? ` -> ${check.url}${assertions.length ? ` (assert ${assertions.join(', ')})` : ''}` : ' (manual)';
            lines.push(bullet(`${check.id} [${kind} check] ${check.description}${target}${links.length ? ` (verifies ${links.join('; ')})` : ''}${check.workingDirectory ? ` [cwd ${check.workingDirectory}]` : ''}`));
          } else lines.push(warn('(none)'));
          lines.push(section('Tasks'));
          if (change.tasks.length) for (const task of change.tasks) {
            const links = [
              ...(task.dependencies.length ? [`after ${task.dependencies.join(', ')}`] : []),
              ...(task.requirementIds.length ? [`implements ${task.requirementIds.join(', ')}`] : []),
            ];
            lines.push(bullet(`${task.id} [${task.status}] ${task.title}${links.length ? ` (${links.join('; ')})` : ''}`));
          } else lines.push(warn('(none)'));
          lines.push(section('Capability'));
          lines.push(kv('Name', change.capabilityName ?? '(not declared)'));
          lines.push(kv('Contribution', capabilityContribution(change)));
          lines.push(kv('Baseline revision', change.baselineRevision === undefined ? '(not captured)' : String(change.baselineRevision)));
          lines.push(kv('Impact', change.capabilityImpact ?? '(not declared)'));
          lines.push(kv('Rationale', change.capabilityRationale?.trim() || '(none)'));
          const deltaOperations = change.capabilityDelta?.operations ?? [];
          lines.push(kv('Delta', deltaOperations.length ? `${deltaOperations.length} operation(s)` : '(none)'));
          for (const operation of deltaOperations) lines.push(bullet(`${operation.operation} ${operation.requirementId}: ${operation.rationale}`));
          lines.push(divider());
          lines.push(section('Readiness'));
          lines.push(kv('Ready', result.readiness.ready ? ok('yes') : err('no')));
          if (result.readiness.blockers?.length) {
            lines.push(section('Blockers'));
            for (const b of result.readiness.blockers) lines.push(bullet(String(b.message ?? b)));
          } else {
            lines.push(bullet('No blockers.'));
          }
          console.log(box(lines));
        }
      } else if (action === 'update') {
        const itemKind = positional[3];
        if (itemKind !== undefined) {
          if (!isChangeKind(itemKind)) fail('usage_error', usage, 'Use `notchlet change update <change> requirement|check|scenario|decision|task <item-id> [fields]`.', 64);
          assertOptions([...AUTHORED_OPTIONS[itemKind], '--revision'], `change update ${itemKind}`);
          const root = await requireWorkspace('change update');
          const changeRef = positional[2];
          const itemId = positional[4];
          if (!changeRef || !itemId) fail('usage_error', usage, `Provide a change and item ID to edit a ${itemKind}.`, 64);
          const patch = itemPatchFromOptions(itemKind);
          if (Object.keys(patch).length === 0) fail('usage_error', usage, `Provide at least one editable ${itemKind} field: ${AUTHORED_OPTIONS[itemKind].join(', ')}.`, 64);
          const id = await resolveChangeRef(root, changeRef);
          const change = await mutateChange(root, id, current => updateChangeItem(current, itemKind, itemId, patch), revisionOption());
          printWithSync(change, await syncIfAutomatic(root, id), `Updated ${itemKind} ${itemId} in ${id} (revision ${change.revision ?? 0}).`);
        } else {
          assertOptions(['--change', '--intent', '--outcome', '--capability-name', '--capability-impact', '--capability-rationale', '--evidence-policy', '--run-command', '--preview-url', '--readiness-url', '--working-directory', '--ready-timeout', '--ready-interval', '--environment', '--setup', '--teardown', '--coverage-policy', '--revision'], 'change update');
          const root = await requireWorkspace('change update');
          const changeRef = positional[2] ?? optionValue('--change');
          if (!changeRef) fail('usage_error', usage, 'Provide a change name or ID.', 64);
          const id = await resolveChangeRef(root, changeRef);
          const environment = environmentOption();
          const update = {
            ...(optionValue('--intent') === undefined ? {} : { intent: optionValue('--intent') }),
            ...(optionValue('--outcome') === undefined ? {} : { outcome: optionValue('--outcome') }),
            ...(optionValue('--capability-name') === undefined ? {} : { capabilityName: optionValue('--capability-name') }),
            ...(optionValue('--capability-impact') === undefined ? {} : { capabilityImpact: optionValue('--capability-impact') as 'none' | 'delta' }),
            ...(optionValue('--capability-rationale') === undefined ? {} : { capabilityRationale: optionValue('--capability-rationale') }),
            ...(optionValue('--evidence-policy') === undefined ? {} : { evidencePolicy: optionValue('--evidence-policy') as 'per-task' | 'end-of-change' }),
            ...(optionValue('--run-command') === undefined ? {} : { runCommand: optionValue('--run-command') }),
            ...(optionValue('--preview-url') === undefined ? {} : { previewUrl: optionValue('--preview-url') }),
            ...(optionValue('--readiness-url') === undefined ? {} : { readinessUrl: optionValue('--readiness-url') }),
            ...(optionValue('--working-directory') === undefined ? {} : { workingDirectory: optionValue('--working-directory') }),
            ...(environment === undefined ? {} : { environment }),
            ...(optionValue('--setup') === undefined ? {} : { setupCommand: optionValue('--setup') }),
            ...(optionValue('--teardown') === undefined ? {} : { teardownCommand: optionValue('--teardown') }),
            ...(optionValue('--coverage-policy') === undefined ? {} : { coveragePolicy: optionValue('--coverage-policy') as 'advisory' | 'strict' }),
            ...(parseRevisionOption('--ready-timeout') === undefined ? {} : { readyTimeoutMs: parseRevisionOption('--ready-timeout') }),
            ...(parseRevisionOption('--ready-interval') === undefined ? {} : { readyIntervalMs: parseRevisionOption('--ready-interval') }),
          };
          if (Object.keys(update).length === 0) fail('usage_error', usage, 'Provide at least one editable change field.', 64);
          if (update.capabilityImpact !== undefined && !['none', 'delta'].includes(update.capabilityImpact)) fail('usage_error', usage, 'Use --capability-impact none or --capability-impact delta.', 64);
          if (update.evidencePolicy !== undefined && !['per-task', 'end-of-change'].includes(update.evidencePolicy)) fail('usage_error', usage, 'Use --evidence-policy per-task or --evidence-policy end-of-change.', 64);
          if (update.coveragePolicy !== undefined && !['advisory', 'strict'].includes(update.coveragePolicy)) fail('usage_error', usage, 'Use --coverage-policy advisory or --coverage-policy strict.', 64);
          const change = await mutateChange(root, id, current => applyChangeUpdate(current, update), { ...revisionOption(), refreshExecution: Object.keys(update).some(field => EXECUTION_FIELDS.has(field)) });
          printWithSync(change, await syncIfAutomatic(root, id), `Updated change ${id} (revision ${change.revision ?? 0}).`);
        }
      } else if (action === 'add') {
        const changeRef = positional[2];
        const kind = positional[3];
        if (!changeRef || !isChangeKind(kind)) fail('usage_error', usage, 'Use `notchlet change add <change> requirement|check|scenario|decision|task [options]`.', 64);
        assertOptions(['--id', ...AUTHORED_OPTIONS[kind], '--revision'], `change add ${kind}`);
        const root = await requireWorkspace('change add');
        const id = await resolveChangeRef(root, changeRef);
        const itemId = optionValue('--id');
        if (!itemId) fail('usage_error', usage, 'Provide --id for the new item.', 64);
        const required = (name: string): string => {
          const value = optionValue(name);
          if (!value?.trim()) fail('usage_error', usage, `Provide ${name} for this ${kind}.`, 64);
          return value;
        };
        const change = await mutateChange(root, id, current => {
          if (kind === 'requirement') return addRequirementToChange(current, { id: itemId, title: required('--title'), description: required('--description') });
          if (kind === 'check') {
            const requirementIds = optionValues('--requirement');
            const scenarioIds = optionValues('--scenario');
            const taskIds = optionValues('--task');
            const checkKind = optionValue('--kind');
            if (checkKind !== undefined && !['command', 'manual', 'browser', 'http', 'ui'].includes(checkKind)) fail('usage_error', usage, 'Use --kind command, --kind http, --kind browser, --kind ui, or --kind manual.', 64);
            const settleRaw = optionValue('--settle-ms');
            const settleMs = settleRaw === undefined ? undefined : Number(settleRaw);
            if (settleMs !== undefined && (!Number.isInteger(settleMs) || settleMs < 0)) fail('usage_error', usage, 'Provide a non-negative integer --settle-ms.', 64);
            const expectedSelectors = rawOptionValues('--expected-selector');
            const expectedStatus = optionValue('--expected-status');
            if (expectedStatus !== undefined && (!Number.isInteger(Number(expectedStatus)) || Number(expectedStatus) < 100 || Number(expectedStatus) > 599)) fail('usage_error', usage, 'Provide --expected-status as an HTTP status between 100 and 599.', 64);
            const expectedJson = optionValue('--expected-json');
            let parsedExpectedJson: Record<string, unknown> | undefined;
            if (expectedJson !== undefined) {
              let parsed: unknown;
              try { parsed = JSON.parse(expectedJson); } catch { fail('invalid_input', '--expected-json is not valid JSON.', 'Provide a JSON object such as {"status":"ok"}.', 2); }
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_input', '--expected-json must be a JSON object.', 'Provide a JSON object such as {"status":"ok"}.', 2);
              parsedExpectedJson = parsed as Record<string, unknown>;
            }
            const expectedJsonContains = jsonOption('--expected-json-contains');
            const expectedJsonAt = jsonPathAssertionsOption();
            const expectedHeaders = expectedHeadersOption();
            return addCheckToChange(current, {
              id: itemId,
              description: required('--description'),
              ...(checkKind === undefined ? {} : { kind: checkKind as 'command' | 'manual' | 'browser' | 'http' | 'ui' }),
              ...(optionValue('--command') === undefined ? {} : { command: optionValue('--command') }),
              ...(optionValue('--url') === undefined ? {} : { url: optionValue('--url') }),
              ...(optionValue('--expected-body-contains') === undefined ? {} : { expectedBodyContains: optionValue('--expected-body-contains') }),
              ...(parsedExpectedJson === undefined ? {} : { expectedJson: parsedExpectedJson }),
              ...(expectedJsonContains === undefined ? {} : { expectedJsonContains }),
              ...(expectedJsonAt === undefined ? {} : { expectedJsonAt }),
              ...(expectedHeaders === undefined ? {} : { expectedHeaders }),
              ...(optionValue('--working-directory') === undefined ? {} : { workingDirectory: optionValue('--working-directory') }),
              ...(expectedStatus === undefined ? {} : { expectedStatus: Number(expectedStatus) }),
              ...(optionValue('--wait-for') === undefined ? {} : { waitFor: optionValue('--wait-for') }),
              ...(settleMs === undefined ? {} : { settleMs }),
              ...(expectedSelectors.length ? { expectedSelectors } : {}),
              ...(optionValue('--expected-text') === undefined ? {} : { expectedText: optionValue('--expected-text') }),
              ...(args.includes('--expect-no-console-errors') ? { expectedNoConsoleErrors: true } : {}),
              ...(args.includes('--full-page') ? { fullPage: true } : {}),
              ...(requirementIds.length ? { requirementIds } : {}),
              ...(scenarioIds.length ? { scenarioIds } : {}),
              ...(taskIds.length ? { taskIds } : {}),
            });
          }
          if (kind === 'scenario') return addScenarioToChange(current, { id: itemId, requirementId: required('--requirement'), when: required('--when'), then: required('--then') });
          if (kind === 'decision') return addDesignDecisionToChange(current, { id: itemId, decision: required('--decision'), rationale: required('--rationale') });
          return addTaskToChange(current, { id: itemId, title: required('--title'), status: 'pending', dependencies: optionValues('--depends-on'), requirementIds: optionValues('--requirement') });
        }, revisionOption());
        printWithSync(change, await syncIfAutomatic(root, id), `Added ${kind} ${itemId} to ${id} (revision ${change.revision ?? 0}).`);
      } else if (action === 'remove') {
        assertOptions(['--id', '--revision'], 'change remove');
        const root = await requireWorkspace('change remove');
        const changeRef = positional[2];
        const kind = positional[3];
        const collections: Record<string, ChangeCollection> = { requirement: 'requirements', check: 'checks', scenario: 'acceptanceScenarios', decision: 'designDecisions', task: 'tasks' };
        const collection = collections[kind ?? ''];
        const itemId = positional[4] ?? optionValue('--id');
        if (!changeRef || !collection || !itemId) fail('usage_error', usage, 'Use `notchlet change remove <change> requirement|check|scenario|decision|task <item-id>`.', 64);
        const id = await resolveChangeRef(root, changeRef);
        const change = await removeChangeItem(root, id, collection, itemId, revisionOption());
        printWithSync(change, await syncIfAutomatic(root, id), `Removed ${kind} ${itemId} from ${id} (revision ${change.revision ?? 0}).`);
      } else if (action === 'convert') {
        assertOptions(['--schema', '--revision'], 'change convert');
        const root = await requireWorkspace('change convert');
        const changeRef = positional[2] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        const schema = optionValue('--schema') ?? (isTty() && !changeRef ? await prompt('Schema (quick|standard): ') : undefined);
        if (!changeRef || (schema !== 'quick' && schema !== 'standard')) fail('usage_error', usage, 'Use `--schema quick` or `--schema standard`.', 64);
        const id = await resolveChangeRef(root, changeRef);
        const change = await persistConversion(root, id, schema, revisionOption());
        const result = { change, readiness: readiness(change, await artifactContents(root, id, change)) };
        printWithSync(result, await syncIfAutomatic(root, id), `Converted change ${id} to ${schema} schema.`);
      } else if (action === 'apply') {
        assertOptions(['--file', '--revision'], 'change apply');
        const root = await requireWorkspace('change apply');
        const changeRef = positional[2];
        const file = optionValue('--file');
        if (!changeRef || !file) fail('usage_error', usage, 'Use `notchlet change apply <change> --file <path> [--revision <n>]`.', 64);
        const id = await resolveChangeRef(root, changeRef);
        let value: unknown;
        try { value = JSON.parse(await readFile(path.resolve(process.cwd(), file), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('invalid_input', `Batch file not found: ${file}`, 'Provide an existing JSON file with expectedRevision and operations.', 2); fail('invalid_input', 'Batch file is not valid JSON.', 'Correct the JSON file and try again.', 2); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('usage_error', 'Batch file must be a JSON object.', 'Provide expectedRevision and an operations array.', 64);
        const record = value as Record<string, unknown>;
        const unsupported = Object.keys(record).find(key => key !== 'expectedRevision' && key !== 'operations');
        if (unsupported) fail('usage_error', `Unsupported batch field ${unsupported}.`, 'Use only expectedRevision and operations.', 64);
        let batchRevision: number | undefined;
        if (record.expectedRevision !== undefined) {
          if (!Number.isInteger(record.expectedRevision) || (record.expectedRevision as number) < 0) fail('usage_error', 'expectedRevision must be a non-negative integer.', 'Correct the batch file and try again.', 64);
          batchRevision = record.expectedRevision as number;
        }
        const expected = parseRevisionOption('--revision') ?? batchRevision;
        const operations = parseChangeOperations(record.operations);
        const refreshExecution = operations.some(operation => operation.op === 'field' && Object.keys(operation.update).some(field => EXECUTION_FIELDS.has(field)));
        const result = await persistChangeOperations(root, id, operations, { ...(expected === undefined ? {} : { expectedRevision: expected }), refreshExecution });
        printWithSync({ change: result.change, applied: result.applied }, await syncIfAutomatic(root, id), `Applied ${result.applied} operation(s) to ${id} (revision ${result.change.revision ?? 0}).`);
      } else if (action === 'render') {
        assertOptions(['--check', '--write', '--force', '--markdown'], 'change render');
        const root = await requireWorkspace('change render');
        const changeRef = positional[2];
        if (!changeRef) fail('usage_error', usage, 'Use `notchlet change render <change> [--check|--write] [--force]`.', 64);
        if (args.includes('--check') && args.includes('--write')) fail('usage_error', 'Choose either --check or --write for change render.', 'Use --check to report drift without writing, or --write to render artifacts.', 64);
        if (args.includes('--markdown') && !args.includes('--write')) fail('usage_error', '--markdown requires --write.', 'Add --write to declare and render optional Markdown views.', 64);
        const target = await resolveChangeTarget(root, changeRef);
        const id = target.id;
        if (args.includes('--check')) {
          const result = await inspectChangeArtifacts(root, id);
          if (json) { print({ ...result, archived: target.archived }); }
          else {
            const lines: string[] = [section(`Artifact drift: ${id}`)];
            if (!result.artifacts.length) lines.push(warn('(no declared artifacts)'));
            for (const artifact of result.artifacts) lines.push(kv(`${artifact.artifact} [${artifact.role}]`, `${artifact.status}${artifact.drift ? ` (${artifact.drift} drift)` : ''} - ${artifact.path}`));
            const executionLabel = result.executionDrift.status === 'current' ? ok('current') : result.executionDrift.status === 'drifted' ? err('drifted') : warn('unrecorded');
            lines.push(kv('Execution metadata', `${executionLabel}${result.executionDrift.status === 'drifted' ? ` — ${result.executionDrift.recovery}` : ''}`));
            lines.push(kv('Drifted', result.drifted || result.executionDrift.status === 'drifted' ? err('yes') : ok('no')));
            console.log(box(lines));
          }
          if (result.drifted || result.executionDrift.status === 'drifted') process.exitCode = 1;
        } else if (args.includes('--write')) {
          if (target.archived) fail('archived_change', `Change ${id} is archived and cannot be rendered in place.`, `Restore it with \`notchlet change restore ${id}\` first.`, 1);
          const result = await writeChangeArtifacts(root, id, { force: args.includes('--force'), markdown: args.includes('--markdown') });
          const automaticSync = await syncIfAutomatic(root, id);
          if (json) { printWithSync(result, automaticSync); }
          else {
            const lines: string[] = [section(`Artifacts rendered: ${id}`)];
            lines.push(kv('Written', result.written.join(', ') || '(none)'));
            lines.push(kv('Unchanged', result.unchanged.join(', ') || '(none)'));
            for (const refusal of result.refused) lines.push(kv('Refused', `${refusal.artifact} (${refusal.reason})`));
            lines.push(kv('Revision', String(result.change.revision ?? 0)));
            console.log(box(lines));
            if (automaticSync) console.log(`Automatic sync: ${(automaticSync as any)?.state ?? 'pending'}`);
          }
          if (result.refused.length) process.exitCode = 1;
        } else {
          const change = target.archived ? await readArchivedChange(root, id) : await readChange(root, id);
          const rendered = renderChangeArtifacts(args.includes('--markdown') ? withMarkdownArtifacts(change) : change);
          if (json) { print({ change: id, archived: target.archived, artifacts: rendered }); }
          else console.log(rendered.length ? rendered.map(item => `${item.artifact}: ${item.path}\n\n${item.content}`).join('\n---\n\n') : warn('No renderable artifacts are declared.'));
        }
      } else if (action === 'baseline') {
        assertOptions(['--capability', '--capability-name', '--revision'], 'change baseline');
        const root = await requireWorkspace('change baseline');
        const changeRef = positional[2];
        if (!changeRef) fail('usage_error', usage, 'Use `notchlet change baseline <change> [--revision <n>]`.', 64);
        const id = await resolveChangeRef(root, changeRef);
        const expected = parseRevisionOption('--revision');
        const capabilityName = optionValue('--capability') ?? optionValue('--capability-name');
        const captured = await captureCapabilityBaseline(root, id, {
          ...(capabilityName === undefined ? {} : { capabilityName }),
          ...(expected === undefined ? {} : { expectedRevision: expected }),
        });
        printWithSync(captured, await syncIfAutomatic(root, id), `Captured baseline ${captured.baselineName} at revision ${captured.baselineRevision} for ${id} (change revision ${captured.change.revision ?? 0}).`);
        if (!json) { const hint = await renderHint(root, id); if (hint) console.log(warn(hint)); }
      } else if (action === 'delta') {
        assertOptions(['--requirement', '--rationale', '--all-missing', '--revision'], 'change delta');
        const root = await requireWorkspace('change delta');
        const changeRef = positional[2];
        const operation = positional[3];
        if (!changeRef || !['add', 'update', 'remove', 'delete'].includes(operation ?? '')) fail('usage_error', usage, 'Use `notchlet change delta <change> add|update|remove|delete --requirement <id[,id]> [--rationale <text>]`, or `add --all-missing --rationale <text>`.', 64);
        const id = await resolveChangeRef(root, changeRef);
        const requirementIds = optionValues('--requirement');
        const allMissing = args.includes('--all-missing');
        if (!allMissing && !requirementIds.length) fail('usage_error', usage, 'Provide --requirement (comma-separated for several IDs) or --all-missing.', 64);
        if (allMissing && (operation !== 'add' || requirementIds.length)) fail('usage_error', usage, '--all-missing is only valid with add and cannot be combined with --requirement.', 64);
        const expected = parseRevisionOption('--revision');
        const revisionOption = expected === undefined ? {} : { expectedRevision: expected };
        if (operation === 'delete') {
          const change = await mutateChange(root, id, current => requirementIds.reduce((next, requirementId) => deleteCapabilityDeltaOperation(next, requirementId), current), revisionOption);
          printWithSync(change, await syncIfAutomatic(root, id), `Deleted ${requirementIds.length} delta operation(s) in ${id} (revision ${change.revision ?? 0}).`);
        } else {
          const rationale = optionValue('--rationale');
          if (!rationale?.trim()) fail('usage_error', usage, 'Provide --rationale for the delta operation.', 64);
          const change = await mutateChange(root, id, current => allMissing
            ? seedCapabilityDeltaOperations(current, rationale)
            : authorCapabilityDeltaOperations(current, requirementIds.map(requirementId => ({ operation: operation as 'add' | 'update' | 'remove', requirementId, rationale }))), revisionOption);
          printWithSync(change, await syncIfAutomatic(root, id), `${allMissing ? 'Seeded' : 'Authored'} delta operation(s) ${requirementIds.length ? `for ${requirementIds.join(', ')}` : 'for uncovered requirements'} in ${id} (revision ${change.revision ?? 0}).`);
        }
        if (!json) { const hint = await renderHint(root, id); if (hint) console.log(warn(hint)); }
      } else if (action === 'plan') {
        assertOptions(['--file'], 'change plan');
        const root = await requireWorkspace('change plan');
        const planAction = positional[2];
        if (planAction === 'validate') {
          const input = positional[3] ?? optionValue('--file');
          if (!input) fail('usage_error', usage, 'Use `notchlet change plan validate <path>`.', 64);
          const file = await resolvePlanPath(root, input);
          let parsed: unknown;
          try { parsed = JSON.parse(await readFile(file, 'utf8')); }
          catch (error) { fail('invalid_plan', `Could not parse plan ${input}: ${error instanceof Error ? error.message : String(error)}.`, 'Fix the JSON syntax and run validate again.', 2); }
          const plan = parseChangePlan(parsed);
          const counts = { requirements: plan.requirements.length, scenarios: plan.acceptanceScenarios.length, checks: plan.checks.length, tasks: plan.tasks.length };
          if (json) print({ valid: true, path: file, counts });
          else console.log(box([section('Plan validation'), kv('Path', file), kv('Valid', ok('yes')), kv('Contents', `${counts.requirements} requirement(s), ${counts.scenarios} scenario(s), ${counts.checks} check(s), ${counts.tasks} task(s)`)]));
        } else if (planAction === 'status' || planAction === 'sync') {
          const changeRef = positional[3] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
          if (!changeRef) fail('usage_error', usage, `Use \`notchlet change plan ${planAction} <change>\`.`, 64);
          const target = await resolveChangeTarget(root, changeRef);
          const id = target.id;
          if (planAction === 'sync' && target.archived) fail('archived_change', `Change ${id} is archived and cannot be synced.`, `Inspect it with \`notchlet change plan status ${id}\`, or restore it with \`notchlet change restore ${id}\` before syncing.`, 1);
          const change = target.archived ? await readArchivedChange(root, id) : await readChange(root, id);
          if (!change.sourcePlan) fail('plan_unlinked', `Change ${id} was not created from an imported plan.`, 'Import a plan with `notchlet change new <name> --from <plan.json>` to record provenance.', 1);
          const inspection = await inspectPlan(root, change);
          if (planAction === 'sync') {
            const base = path.resolve(root);
            const absolute = path.resolve(base, change.sourcePlan.path);
            if (absolute !== base && !absolute.startsWith(base + path.sep)) fail('invalid_plan', 'The recorded plan path escapes the workspace.', 'Restore a source plan inside the workspace, or re-import the change.', 1);
            let content: string;
            try { content = await readFile(absolute, 'utf8'); }
            catch { fail('plan_not_found', `Source plan is not readable: ${change.sourcePlan.path}.`, 'Restore the plan file, or accept the missing provenance with `change close --accept-plan-drift`.', 1); }
            let plan;
            try { plan = parseChangePlan(JSON.parse(content)); }
            catch (error) { fail('invalid_plan', `Source plan no longer validates: ${error instanceof Error ? error.message : String(error)}.`, 'Fix the plan before syncing its provenance hash.', 2); }
            const sha256 = createHash('sha256').update(content).digest('hex');
            const updated = await mutateChange(root, id, current => ({ ...current, sourcePlan: { path: current.sourcePlan!.path, sha256, importedAt: new Date().toISOString() } }));
            const result = { change: updated, plan: await inspectPlan(root, updated), counts: { requirements: plan.requirements.length, scenarios: plan.acceptanceScenarios.length, checks: plan.checks.length, tasks: plan.tasks.length } };
            printWithSync(result, await syncIfAutomatic(root, id), `Synced plan provenance for ${id} to ${sha256.slice(0, 12)} (revision ${updated.revision ?? 0}). Plan content was not re-imported; only the recorded hash changed.`);
          } else {
            const plan = json || inspection.validation.status !== 'ok' ? undefined : parseChangePlan(JSON.parse(await readFile(path.resolve(root, change.sourcePlan.path), 'utf8')));
            const result = { plan: inspection, sourcePlan: change.sourcePlan, ...(target.archived ? { archived: true } : {}), ...(plan === undefined ? {} : { counts: { requirements: plan.requirements.length, scenarios: plan.acceptanceScenarios.length, checks: plan.checks.length, tasks: plan.tasks.length } }) };
            if (json) print(result);
            else {
              const lines = [section(`Plan provenance: ${id}${target.archived ? ' (archived)' : ''}`)];
              if (target.archived) lines.push(kv('Archived', ok('yes')));
              lines.push(kv('Source plan', change.sourcePlan.path), kv('Recorded SHA-256', change.sourcePlan.sha256), kv('Imported at', change.sourcePlan.importedAt), kv('Contract SHA-256', inspection.contractSha256));
              lines.push(kv('Drift', inspection.drift.status === 'none' ? ok('current') : inspection.drift.status === 'missing' ? err('missing') : err(`drifted${inspection.drift.reason ? ` — ${inspection.drift.reason}` : ''}`)));
              if (inspection.currentSha256) lines.push(kv('Current SHA-256', inspection.currentSha256));
              lines.push(kv('Validation', inspection.validation.status === 'ok' ? ok('valid') : inspection.validation.status === 'invalid' ? err(`invalid — ${inspection.validation.error}`) : 'not applicable'));
              if (inspection.drift.status !== 'none') lines.push(warn('Run `notchlet change plan sync <change>` to accept the current plan hash, or re-import the change to apply plan content.'));
              console.log(box(lines));
            }
          }
        } else fail('usage_error', usage, 'Use `notchlet change plan validate <path>`, `change plan status <change>`, or `change plan sync <change>`.', 64);
      } else if (action === 'close') {
        assertOptions(['--preview', '--baseline-revision', '--yes', '--markdown', '--accept-plan-drift'], 'change close');
        const root = await requireWorkspace('change close');
        const changeRef = positional[2] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        if (!changeRef) fail('usage_error', usage, 'Provide a change name or ID.', 64);
        const id = await resolveChangeRef(root, changeRef);
        const change = await readChange(root, id);
        const preview = await previewCapabilityClose(root, id);
        const planInspection = await inspectPlan(root, change);
        if (args.includes('--preview')) {
          if (json) { print({ ...preview, plan: planInspection, planDrift: planInspection.drift }); }
          else {
            const lines: string[] = [];
            lines.push(section(`Closure preview: ${id}`));
            lines.push(kv('Capability contribution', preview.contribution));
            lines.push(kv('Planning readiness', preview.readiness.ready ? ok('ready') : err(`not ready (${preview.readiness.blockers.length} blocker(s))`)));
            lines.push(kv('Artifacts', preview.artifacts.length ? preview.artifacts.map(artifact => `${artifact.artifact} [${artifact.role}]: ${artifact.status}`).join(', ') : 'none declared'));
            if (preview.contribution !== 'none') {
              lines.push(kv('Baseline name', preview.baselineName));
              lines.push(kv('Baseline revision', String(preview.baselineRevision)));
              if (preview.delta === undefined) lines.push(kv('Capability delta', warn('not declared')));
              else lines.push(kv('Capability delta', `${preview.delta.operations.length} operation(s); additions ${preview.additions?.length ?? 0}, updates ${preview.updates?.length ?? 0}, removals ${preview.removals?.length ?? 0}`));
            } else {
              lines.push(kv('Capability baseline', 'not applicable (no-impact closure writes no baseline)'));
            }
            lines.push(kv('Verification', `${preview.verification.status} (${preview.verification.basis} basis)`));
            if (preview.verification.missing.length) lines.push(kv('Missing checks', preview.verification.missing.join(', ')));
            if (preview.verification.failed.length) lines.push(kv('Failed checks', preview.verification.failed.join(', ')));
            if (preview.verification.stale.length) lines.push(kv('Stale checks', preview.verification.stale.join(', ')));
            if (preview.verification.unknown.length) lines.push(kv('Unknown checks', preview.verification.unknown.join(', ')));
            if (preview.verification.recovery) lines.push(kv('Verification recovery', preview.verification.recovery));
            lines.push(kv('Local closure', preview.localClosure.ready ? ok('ready') : err(`${preview.localClosure.blockerCount} blocker(s)`)));
            lines.push(kv('Coverage', `${preview.coverage.policy}: ${preview.coverage.requirements.covered}/${preview.coverage.requirements.total} requirements, ${preview.coverage.scenarios.covered}/${preview.coverage.scenarios.total} scenarios${preview.coverage.unlinkedChecks.length ? `; unlinked checks: ${preview.coverage.unlinkedChecks.join(', ')}` : ''}`));
            lines.push(kv('Remote delivery', preview.remoteDelivery.status));
            if (planInspection.drift.status !== 'unlinked') {
              const label = planInspection.drift.status === 'none' ? ok('current') : planInspection.drift.status === 'missing' ? warn('missing') : err('drifted');
              lines.push(kv('Plan source', `${planInspection.drift.path ?? '(unknown)'}: ${label}${planInspection.drift.reason ? ` — ${planInspection.drift.reason}` : ''}`));
              lines.push(kv('Plan contract', planInspection.contractSha256));
              lines.push(kv('Plan validation', planInspection.validation.status === 'ok' ? ok('valid') : planInspection.validation.status === 'invalid' ? err(`invalid — ${planInspection.validation.error}`) : 'not applicable'));
            } else {
              lines.push(kv('Plan source', 'not linked to an imported plan'));
            }
            const presenceOnly = presenceOnlyUiChecks(change);
            if (presenceOnly.length) lines.push(kv('Advisory', warn(`presence-only UI check${presenceOnly.length === 1 ? '' : 's'} ${presenceOnly.map(check => check.id).join(', ')}`)));
            const setupHint = setupAdvisory(change);
            if (setupHint) lines.push(kv('Advisory', warn(setupHint.message)));
            const history = await readAttemptHistory(root, id);
            const unstable = history.checks.filter(check => check.attempts > 1 && check.signatures.some(signature => signature.count > 1));
            if (unstable.length) lines.push(kv('Attempt history', warn(`${unstable.map(check => `${check.id} failed the same way up to ${Math.max(...check.signatures.map(signature => signature.count))}×`).join('; ')}. Run \`notchlet status ${id} --history\` for details.`)));
            lines.push(bullet('Readiness is planning validation; verification is check evidence; local closure does not imply remote delivery.'));
            if (preview.verification.basis === 'artifact') lines.push(warn('No Git repository was observed; freshness was evaluated from change artifacts only.'));
            if (preview.blockers?.length) {
              lines.push(section('Blockers'));
              for (const b of preview.blockers) lines.push(bullet(`${b.code}: ${b.message}\n  Recovery: ${b.recovery}`));
            }
            console.log(box(lines));
            console.log(warn('No files were changed.'));
          }
        } else {
          const yes = args.includes('--yes');
          if (!yes && isTty()) {
            const confirmed = await confirm(`Are you sure you want to close and archive change ${id}?`);
            if (!confirmed) { console.log(warn('Cancelled.')); return; }
          }
          const revision = parseRevisionOption('--baseline-revision');
          let options: Parameters<typeof closeChange>[2] = { renderMarkdown: args.includes('--markdown'), acceptPlanDrift: args.includes('--accept-plan-drift') };
          if (preview.contribution === 'none') {
            if (revision !== undefined) fail('usage_error', usage, 'A no-impact change closes without --baseline-revision because no capability baseline is written.', 64);
          } else {
            if (revision === undefined) fail('usage_error', usage, 'Provide --baseline-revision from the capability preview.', 64);
            options = { ...options, expectedBaselineRevision: revision };
          }
          const result = await closeChange(root, id, options);
          printWithSync(result, await syncIfAutomatic(root, id), `Closed and archived ${id} locally. Local closure only; remote delivery is unchanged.${preview.contribution === 'none' ? ' No capability baseline was written.' : ` Capability baseline updated to revision ${result.baselineRevision}.`} Closure manifest: ${result.manifestPath}${args.includes('--markdown') ? ' (with closure.md)' : ''}.${result.contractSha256 ? ` Contract SHA-256: ${result.contractSha256}.` : ''}${result.artifactRefresh === 'generated-state' ? ' Lifecycle-only artifact state was refreshed automatically.' : ''} Review with \`notchlet change export ${id} --format json\`.`);
        }
      } else fail('usage_error', usage, 'Run `notchlet --help` for command syntax.', 64);
    } else if (command === 'schema') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('schema', `notchlet schema [name] [--dir]

  List schemas shipped with Notchlet, or print one schema as JSON.

Options:
  [name]       Schema name such as plan.v1, closure.v1, or check.v1
  --dir        Print the directory containing shipped schemas
  --json       Machine-readable JSON output`);
      }
      if (args.includes('--dir')) { print({ directory: schemaDirectory() }, schemaDirectory()); }
      else {
        const name = positional[1];
        if (!name) {
          const schemas = await listSchemas();
          print({ schemas }, schemas.map(schema => `${schema.name}${schema.title ? ` — ${schema.title}` : ''}`).join('\n'));
        } else {
          const schema = await readSchema(name);
          print(schema, JSON.stringify(schema.schema, null, 2));
        }
      }
    } else if (command === 'verify') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('verify', `notchlet verify <change-name|id> [--check <id,...>] [--record] [--requirement <id,...>] [--scenario <id,...>] [--task <id,...>]
                         [--timeout <ms>] [--working-directory <dir>] [--ready-timeout <ms>] [--ready-interval <ms>]
                         [--serve] [--serve-command <cmd>] [--keep-running] [--reuse-serve] [--ui-capture never|on-failure|always]
                         [--environment KEY=value] [--setup <cmd>] [--save-setup] [--teardown <cmd>] [--repeat <n>]
                         [--check-setup-idempotence --setup-state <path>...]
                         [--capture-url <url>] [--browser <path>] [--viewport <w>x<h>] [--wait-for <selector>] [--settle-ms <ms>] [--full-page] [--attach <path>...]

  Run command checks and HTTP probes declared on a change. Manual checks are reported as skipped and require recorded evidence.
  HTTP checks assert status plus optional body, JSON subset/containment/path, and header expectations. Legacy browser checks run as HTTP probes.
  UI checks can assert visibility, enabled state, title, scoped text, and declarative interaction steps; failed captures are archived by default.
  --serve starts the declared run command (or --serve-command), waits for readiness, and stops it after checks unless --keep-running is set.
  An existing listener fails the run unless --reuse-serve is passed; setup is skipped when an external server is reused.
  --repeat reruns the batch (including setup) and reports state_not_idempotent when check outcomes differ, state_drift_under_stable_failure when failing observations change, or readiness_drift_under_stable_failure when startup observations change.
  In JSON, \`ok\` describes command execution; use \`data.result\` or \`data.verification.outcome\` for the verification result. \`repeat.hints\` and \`repeat.setupRan\` summarize remediation.

Options:
  <change>            Change name or ID (required)
  --check <id,...>    Only run the selected check IDs
  --record            Record the result as evidence linked to the executed checks
  --requirement <id,...>  With --record, also link these requirements
  --scenario <id,...> With --record, also link these scenarios
  --task <id,...>     With --record, also link these tasks
  --timeout <ms>      Per-check timeout in milliseconds (default: 120000)
  --working-directory <dir>  Override every check working directory (workspace-relative)
  --ready-timeout <ms>       Override readiness polling timeout for this run
  --ready-interval <ms>      Readiness poll interval in milliseconds (default: 250)
  --serve             Start change.runCommand for the duration of the run
  --serve-command <cmd>      Start this command instead of change.runCommand
  --keep-running      Leave the served app running after checks
  --reuse-serve       Allow --serve to target an already-running server verify does not own
  --ui-capture <policy>      Archive UI captures: never, on-failure (default), or always
  --environment <K=V> Environment variable for served/setup/teardown/check commands (repeatable)
  --setup <cmd>       Setup command run before checks
  --save-setup        Persist --setup on the change so later runs reset state
  --teardown <cmd>    Teardown command run after checks
  --repeat <n>        Run the check batch n times (1-10) and detect state-dependent failures
  --check-setup-idempotence  Run setup twice and fail when declared state paths change
  --setup-state <path>       File or directory setup must reproduce (repeatable; requires --check-setup-idempotence)
  --capture-url <url> With --record, capture a headless screenshot and DOM snapshot after checks
  --browser <path>    Browser executable used by UI checks and --capture-url
  --viewport <w>x<h>  Capture viewport (default 1280x900)
  --wait-for <selector> Wait for a rendered DOM selector before capturing
  --settle-ms <ms>    Quiet period after load and selector readiness (default: 250)
  --full-page         Capture the full scrollable page instead of the viewport
  --attach <path>     With --record, copy a screenshot/DOM/text/JSON file into the change evidence (repeatable)
  --workspace <root>  Set workspace root
  --json              Machine-readable JSON output`);
      }
      const root = await requireWorkspace('verify');
      const changeRef = positional[1] ?? optionValue('--change');
      if (!changeRef) fail('usage_error', usage, 'Provide a change name or ID for verify.', 64);
      const id = await resolveChangeRef(root, changeRef);
      let change = await readChange(root, id);
      const checkIds = optionValues('--check');
      const unknown = checkIds.filter(checkId => !change.checks.some(check => check.id === checkId));
      if (unknown.length) fail('unknown_check', `Unknown check ID(s): ${unknown.join(', ')}.`, 'Use check IDs from `notchlet change show`.', 2);
      const explicitRequirementIds = optionValues('--requirement');
      const explicitScenarioIds = optionValues('--scenario');
      const explicitTaskIds = optionValues('--task');
      if (!args.includes('--record') && (explicitRequirementIds.length || explicitScenarioIds.length || explicitTaskIds.length)) {
        fail('usage_error', '--requirement, --scenario, and --task require --record.', 'Add --record to store evidence with the explicit links, or omit the links.', 64);
      }
      const attachments = optionValues('--attach');
      if (attachments.length && !args.includes('--record')) fail('usage_error', '--attach requires --record.', 'Add --record to store attachments with the verification evidence.', 64);
      const captureUrl = optionValue('--capture-url');
      if (captureUrl && !args.includes('--record')) fail('usage_error', '--capture-url requires --record.', 'Add --record to store the screenshot and DOM snapshot as evidence.', 64);
      const keepRunning = args.includes('--keep-running');
      const reuseServe = args.includes('--reuse-serve');
      const serveCommand = optionValue('--serve-command');
      if (keepRunning && !args.includes('--serve') && serveCommand === undefined) fail('usage_error', '--keep-running requires --serve or --serve-command.', 'Add --serve to let verify start the declared run command.', 64);
      if (reuseServe && !args.includes('--serve') && serveCommand === undefined) fail('usage_error', '--reuse-serve requires --serve or --serve-command.', 'Add --serve to target the running server explicitly.', 64);
      const uiCapture = optionValue('--ui-capture');
      if (uiCapture !== undefined && !['never', 'on-failure', 'always'].includes(uiCapture)) fail('usage_error', '--ui-capture must be never, on-failure, or always.', 'For example: --ui-capture always.', 64);
      const timeoutMs = optionValue('--timeout') === undefined ? undefined : Number(optionValue('--timeout'));
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) fail('usage_error', usage, 'Provide a positive --timeout in milliseconds.', 64);
      const readyTimeoutMs = parseRevisionOption('--ready-timeout');
      const readyIntervalMs = parseRevisionOption('--ready-interval');
      if (readyIntervalMs === 0) fail('usage_error', usage, 'Provide a positive --ready-interval in milliseconds.', 64);
      const workingDirectory = optionValue('--working-directory');
      const environment = environmentOption();
      const setupCommand = optionValue('--setup');
      const teardownCommand = optionValue('--teardown');
      const saveSetup = args.includes('--save-setup');
      if (saveSetup && !setupCommand) fail('usage_error', '--save-setup requires --setup <cmd>.', 'Provide the setup command to persist, for example: --setup "npm run seed" --save-setup.', 64);
      const repeatRaw = optionValue('--repeat');
      const repeat = repeatRaw === undefined ? undefined : Number(repeatRaw);
      if (repeat !== undefined && (!Number.isInteger(repeat) || repeat < 1 || repeat > 10)) fail('usage_error', '--repeat must be an integer from 1 to 10.', 'For example: --repeat 2.', 64);
      if (saveSetup) change = await mutateChange(root, id, current => ({ ...current, setupCommand: setupCommand!.trim() }));
      const setupStatePaths = optionValues('--setup-state');
      const checkSetupIdempotence = args.includes('--check-setup-idempotence');
      if (setupStatePaths.length && !checkSetupIdempotence) fail('usage_error', '--setup-state requires --check-setup-idempotence.', 'Add --check-setup-idempotence to compare state before and after a second setup run.', 64);
      if (checkSetupIdempotence) {
        if (!setupStatePaths.length) fail('usage_error', '--check-setup-idempotence requires at least one --setup-state <path>.', 'Declare the file or directory that setup must reproduce, for example: --setup-state data.', 64);
        if (!(setupCommand ?? change.setupCommand)) fail('setup_required', '--check-setup-idempotence requires a setup command.', 'Provide --setup <cmd> or persist one with --setup <cmd> --save-setup.', 64);
        if (reuseServe) fail('usage_error', '--check-setup-idempotence cannot run with --reuse-serve because setup is skipped.', 'Stop the external server so verify can run setup, or omit --check-setup-idempotence.', 64);
      }
      const viewport = viewportOption();
      const browserPath = optionValue('--browser');
      const waitFor = optionValue('--wait-for');
      const settleRaw = optionValue('--settle-ms');
      const settleMs = settleRaw === undefined ? undefined : Number(settleRaw);
      if (settleMs !== undefined && (!Number.isInteger(settleMs) || settleMs < 0)) fail('usage_error', 'Provide a non-negative integer --settle-ms.', 'For example: --settle-ms 500.', 64);
      const fullPage = args.includes('--full-page');
      const evidenceId = args.includes('--record') ? randomUUID() : undefined;
      let captured: { attachments: Awaited<ReturnType<typeof stageEvidenceAttachments>>; capture: EvidenceCapture } | undefined;
      const afterChecks = captureUrl === undefined ? undefined : async () => {
        const { capturePage } = await import('./capture.js');
        const page = await capturePage({
          url: captureUrl,
          ...(browserPath === undefined ? {} : { browser: browserPath }),
          ...(viewport === undefined ? {} : { viewport }),
          ...(waitFor === undefined ? {} : { waitFor }),
          ...(settleMs === undefined ? {} : { settleMs }),
          fullPage,
        });
        try {
          const provenance = { tool: 'browser-capture' as const, url: page.url, browser: page.browser, capturedAt: page.capturedAt };
          captured = {
            attachments: await stageEvidenceAttachments(root, id, evidenceId!, [
              { path: page.screenshot.path, name: 'capture.png', kind: 'screenshot', description: `Headless screenshot of ${page.url}`, provenance },
              { path: page.dom.path, name: 'capture.html', kind: 'dom', description: `DOM snapshot of ${page.url}`, provenance },
            ]),
            capture: { url: page.url, browser: page.browser, capturedAt: page.capturedAt, viewport: page.viewport, title: page.title, fullPage: page.fullPage, wait: page.wait, console: page.console },
          };
        } finally { await page.cleanup(); }
      };
      const { runChecks, persistVerificationLog, summarizeVerification, describeReadinessObservation } = await import('./verify.js');
      const result = await runChecks(root, change, {
        checkIds,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
        ...(readyIntervalMs === undefined ? {} : { readyIntervalMs }),
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(environment === undefined ? {} : { environment }),
        ...(setupCommand === undefined ? {} : { setupCommand }),
        ...(teardownCommand === undefined ? {} : { teardownCommand }),
        ...(!args.includes('--serve') && serveCommand === undefined ? {} : { serve: { ...(serveCommand === undefined ? {} : { command: serveCommand }), keepRunning, ...(reuseServe ? { reuse: true } : {}) } }),
        ...(reuseServe ? { reuseServe } : {}),
        ...(uiCapture === undefined ? {} : { uiCapture: uiCapture as 'never' | 'on-failure' | 'always' }),
        ...(repeat === undefined ? {} : { repeat }),
        ...(checkSetupIdempotence ? { setupPreflight: { statePaths: setupStatePaths } } : {}),
        ...(afterChecks === undefined ? {} : { afterChecks }),
        capture: {
          ...(browserPath === undefined ? {} : { browser: browserPath }),
          ...(viewport === undefined ? {} : { viewport }),
          ...(settleMs === undefined ? {} : { settleMs }),
          fullPage,
        },
      });
      if (result.runnable === 0 && result.setupPreflight?.status !== 'failed' && result.serve?.ready !== false) {
        const phase = result.setup?.status === 'failed' ? ' The setup command failed.' : '';
        fail('no_check_commands', `No runnable command or HTTP checks were found.${phase}`, `Add a command or HTTP URL with \`notchlet change add ${id} check --id <id> --description <text> --command <cmd>\` or \`--kind http --url <http(s) URL>\`. Manual checks require separately recorded evidence.`, 2);
      }
      let evidence: Awaited<ReturnType<typeof appendEvidence>> | undefined;
      const log = args.includes('--record') || result.setupPreflight?.status === 'failed'
        ? await persistVerificationLog(root, result)
        : undefined;
      if (args.includes('--record')) {
        const executedCheckIds = result.results.filter(check => check.status !== 'skipped').map(check => check.id);
        const scope = resolveEvidenceScope(change, executedCheckIds, { requirementIds: explicitRequirementIds, scenarioIds: explicitScenarioIds, taskIds: explicitTaskIds });
        const staged = attachments.length ? await stageEvidenceAttachments(root, id, evidenceId!, attachments.map(file => ({ path: file }))) : [];
        const captureInputs = result.results.flatMap(check => {
          if (check.capture?.screenshotPath === undefined || check.capture.domPath === undefined) return [];
          return [
            { path: path.join(root, check.capture.screenshotPath), name: `${check.id}-screenshot.png`, kind: 'screenshot' as const, description: `UI capture of ${check.url ?? check.id} (${check.status})` },
            { path: path.join(root, check.capture.domPath), name: `${check.id}-dom.html`, kind: 'dom' as const, description: `UI DOM snapshot of ${check.url ?? check.id} (${check.status})` },
          ];
        });
        const checkCaptures = captureInputs.length ? await stageEvidenceAttachments(root, id, evidenceId!, captureInputs) : [];
        evidence = await appendEvidence(root, id, {
          id: evidenceId!,
          kind: 'check',
          outcome: result.outcome === 'failed' ? 'failed' : 'passed',
          summary: summarizeVerification(result),
          requirementIds: scope.requirementIds,
          taskIds: scope.taskIds,
          checkIds: scope.checkIds,
          provenance: 'recorded',
          environment: result.environment,
          ...(scope.scenarioIds?.length ? { scenarioIds: scope.scenarioIds } : {}),
          ...(captured === undefined ? {} : { capture: captured.capture }),
          ...(staged.length || checkCaptures.length || captured?.attachments.length ? { attachments: [...(captured?.attachments ?? []), ...checkCaptures, ...staged] } : {}),
          ...(log === undefined ? {} : log),
        });
      }
      const failedCheckIds = result.results.filter(check => check.status === 'failed').map(check => check.id);
      const presenceOnly = presenceOnlyUiChecks(change);
      const setupHint = setupAdvisory(change);
      const attemptHistory = result.outcome === 'failed' ? await readAttemptHistory(root, id) : undefined;
      const repeatedFailures = (attemptHistory?.checks ?? []).flatMap(check => {
        if (!failedCheckIds.includes(check.id)) return [];
        const repeated = check.signatures.find(signature => signature.count > 1);
        return repeated ? [`${check.id}: same failure ${repeated.count} times — ${repeated.signature}`] : [];
      });
      if (attemptHistory && attemptHistory.readinessFailures > 1) {
        const repeated = attemptHistory.readinessSignatures.find(signature => signature.count > 1);
        if (repeated) repeatedFailures.push(`readiness: same failure ${repeated.count} times — ${repeated.signature}`);
      }
      const recovery = failedCheckIds.length ? verificationRecovery(id, failedCheckIds) : result.setupPreflight?.status === 'failed' ? result.setupPreflight.recovery : undefined;
      const artifactState = await inspectChangeArtifacts(root, id).catch(() => undefined);
      const renderRecovery = artifactState?.drifted ? `notchlet change render ${id} --write${artifactState.artifacts.some(artifact => artifact.status === 'unmarked' || artifact.drift === 'authored') ? ' --force' : ''}` : undefined;
      const advisories = {
        ...(presenceOnly.length ? { presenceOnly: presenceOnly.map(check => ({ id: check.id, reason: check.reason })) } : {}),
        ...(setupHint ? { setup: setupHint } : {}),
      };
      const data = { result: result.outcome, verification: result, ...(Object.keys(advisories).length ? { advisories } : {}), ...(attemptHistory && failedCheckIds.length ? { history: { logs: attemptHistory.logs, checks: attemptHistory.checks.filter(check => failedCheckIds.includes(check.id)), readinessFailures: attemptHistory.readinessFailures } } : {}), ...(repeatedFailures.length ? { repeatedFailures } : {}), ...(evidence ? { evidence } : {}), ...(log !== undefined && evidence === undefined ? { diagnosticLog: log } : {}), ...(captured ? { capture: captured.capture } : {}), ...(recovery ? { recovery } : {}), ...(artifactState ? { artifacts: artifactState.artifacts, drifted: artifactState.drifted, executionDrift: artifactState.executionDrift } : {}), ...(renderRecovery ? { renderRecovery } : {}) };
      if (json) { print(data); }
      else {
        const lines: string[] = [];
        lines.push(section(`Verification: ${change.name} (${id})`));
        lines.push(kv('Outcome', result.outcome === 'passed' ? ok('passed') : result.outcome === 'failed' ? err('failed') : warn('informational')));
        lines.push(kv('Checks', `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`));
        if (result.failurePhase) lines.push(kv('Failure phase', result.failurePhase));
        if (result.blocked) lines.push(kv('Blocked checks', String(result.blocked)));
        if (result.repeat) {
          const repeatDetail = [
            ...(result.repeat.differing.length ? [`differing ${result.repeat.differing.join(', ')}`] : []),
            ...(result.repeat.drifting?.length ? [`drifting ${result.repeat.drifting.map(entry => entry.checkId).join(', ')}`] : []),
          ].join('; ');
          lines.push(kv('Repeat', `${result.repeat.attempts} attempt(s): ${result.repeat.stable ? ok('stable') : err(`${result.repeat.code ?? 'state_not_idempotent'}${repeatDetail ? ` (${repeatDetail})` : ''}`)}`));
          for (const drift of result.repeat.drifting ?? []) lines.push(kv('Repeat drift', `${drift.checkId}: ${drift.observations.join(' → ')}`));
          if (result.repeat.readiness?.observations.length && (!result.repeat.readiness.stable || result.repeat.readiness.observations.some(observation => !observation.reached))) {
            const sequence = result.repeat.readiness.observations.map(observation => describeReadinessObservation(observation));
            lines.push(kv('Repeat readiness', sequence.join(' → ')));
          }
          for (const hint of result.repeat.hints ?? []) lines.push(kv('Repeat hint', hint));
          if (result.repeat.stable) {
            for (const check of result.repeat.outcomes[0]?.checks ?? []) {
              if (check.observation) lines.push(kv('Repeat observation', `${check.id}: ${check.observation} (identical across ${result.repeat.attempts} attempts)`));
            }
          }
        }
        if (result.environment.environment && Object.keys(result.environment.environment).length) lines.push(kv('Environment', Object.entries(result.environment.environment).map(([name, value]) => `${name}=${value}`).join(', ')));
        if (result.setup) lines.push(kv('Setup', `${result.setup.status} (exit ${result.setup.exitCode ?? 'none'}, ${result.setup.durationMs}ms)`));
        if (result.setupPreflight) {
          const preflight = result.setupPreflight;
          const changes = [
            ...preflight.added.map(item => `added ${item}`),
            ...preflight.removed.map(item => `removed ${item}`),
            ...preflight.changed.map(item => `changed ${item}`),
          ];
          const summary = preflight.status === 'passed'
            ? `passed (setup ran twice; ${preflight.statePaths.join(', ')} unchanged, ${preflight.durationMs}ms)`
            : `failed (${changes.length ? changes.join(', ') : 'declared state changed'}; setup exits ${preflight.firstExitCode ?? 'none'} then ${preflight.secondExitCode ?? 'none'})`;
          lines.push(kv('Setup preflight', preflight.status === 'passed' ? ok(summary) : err(summary)));
          if (preflight.note) lines.push(kv('Preflight note', preflight.note));
          if (preflight.recovery) lines.push(kv('Preflight recovery', preflight.recovery));
        }
        if (result.setupSkippedReason) lines.push(kv('Setup', warn(`skipped (${result.setupSkippedReason})`)));
        if (result.commandIsolation?.length) lines.push(kv('Command isolation', `withheld ${result.commandIsolation.join(', ')} from command checks`));
        if (result.serve) {
          const serveSummary = result.serve.ownership === 'reused' ? 'reused an external server (explicit --reuse-serve)' : result.serve.startedBy === 'setup' ? 'server started by setup' : result.serve.started ? `started${result.serve.ready ? '' : ' but never became ready'}` : 'not started';
          lines.push(kv('Serve', `${serveSummary}${result.serve.port === undefined ? '' : ` on port ${result.serve.port}`}${result.serve.stopped ? '; stopped after checks' : result.serve.keepRunning ? '; left running' : ''}${result.serve.error ? ` — ${result.serve.error}` : ''}`));
          if (result.serve.output.trim()) lines.push(kv('Server output', result.serve.output.trim().split(/\r?\n/).slice(-3).join(' | ')));
        }
        if (result.readiness) {
          const exit = result.readiness.exitCode === undefined ? '' : ` (exit ${result.readiness.exitCode ?? 'none'}${result.readiness.signal ? `, signal ${result.readiness.signal}` : ''})`;
          lines.push(kv('Readiness probe', `${result.readiness.url}: ${result.readiness.reached ? ok('reached') : err('not reached')}${result.readiness.status === undefined ? '' : ` (HTTP ${result.readiness.status})`} after ${result.readiness.waitedMs}ms (${result.readiness.attempts} attempt${result.readiness.attempts === 1 ? '' : 's'})${exit}${result.readiness.error ? ` — ${result.readiness.error}` : ''}`));
        }
        lines.push(divider());
        for (const check of result.results) {
          const status = check.status === 'passed' ? ok('passed') : check.status === 'failed' ? err('failed') : warn(`skipped (${check.stderr || 'not runnable'})`);
          const label = check.declaredKind === 'browser' ? 'http/browser' : check.kind;
          const detail = check.kind === 'http'
            ? `${check.url ?? '(no URL)'} -> HTTP ${check.observedStatus ?? 'none'} (expected ${check.expectedStatus ?? 200})`
            : check.command ? `— ${check.command}${check.workingDirectory ? ` [cwd ${check.workingDirectory}]` : ''}` : '';
          lines.push(bullet(`${check.id} [${label}]: ${status}${detail ? ` ${detail}` : ''}${check.status !== 'skipped' ? ` (${check.durationMs}ms${check.timedOut ? ', timed out' : ''})` : ''}`));
          for (const assertion of check.assertions ?? []) {
            if (assertion.passed) continue;
            lines.push(bullet(`assert ${assertion.kind}${assertion.path ? ` ${assertion.path}` : ''}: expected ${assertion.expected}, observed ${assertion.observed}`, '↳'));
          }
          if (check.capture?.screenshotPath) lines.push(bullet(`capture [${check.capture.policy}]: ${check.capture.screenshotPath} (${check.capture.screenshotBytes} B) + ${check.capture.domPath} (${check.capture.domBytes} B)`, '↳'));
          if (check.stdout.trim()) lines.push(bullet(`stdout: ${check.stdout.trim().split(/\r?\n/).slice(-5).join(' | ')}`));
          if (check.stderr.trim() && check.status !== 'skipped') lines.push(bullet(`stderr: ${check.stderr.trim().split(/\r?\n/).slice(-5).join(' | ')}`));
          for (const hint of check.hints ?? []) lines.push(bullet(`hint: ${hint}`, '↳'));
        }
        if (presenceOnly.length) lines.push(kv('Advisory', warn(`presence-only UI check${presenceOnly.length === 1 ? '' : 's'} ${presenceOnly.map(check => check.id).join(', ')}; add expectedVisibleSelectors, expectedText, or waitForVisible/waitForText to prove state.`)));
        if (setupHint) lines.push(kv('Advisory', warn(setupHint.message)));
        for (const repeated of repeatedFailures) lines.push(kv('Failure repeat', warn(repeated)));
        if (result.teardown) lines.push(kv('Teardown', `${result.teardown.status} (exit ${result.teardown.exitCode ?? 'none'}, ${result.teardown.durationMs}ms)`));
        if (evidence) {
          const links = [
            `checks ${evidence.checkIds?.join(', ') || 'none'}`,
            `requirements ${evidence.requirementIds.join(', ') || 'none'}`,
            ...(evidence.scenarioIds?.length ? [`scenarios ${evidence.scenarioIds.join(', ')}`] : []),
            `tasks ${evidence.taskIds.join(', ') || 'none'}`,
          ];
          lines.push(divider());
          lines.push(kv('Evidence', `${evidence.id} recorded (${links.join('; ')})`));
          if (evidence.logPath) lines.push(kv('Evidence log', `.notchlet/changes/${id}/${evidence.logPath} (${evidence.logBytes ?? 0} bytes, sha256 ${evidence.logHash?.slice(0, 12)}...)`));
          if (evidence.attachments?.length) lines.push(kv('Attachments', evidence.attachments.map(attachment => `${attachment.path} (${attachment.bytes} bytes, ${attachment.kind ?? 'other'})`).join(', ')));
          if (evidence.capture) lines.push(kv('Capture', `${evidence.capture.url} via ${evidence.capture.browser} at ${evidence.capture.capturedAt}`));
        } else if (log) {
          lines.push(kv('Diagnostic log', `.notchlet/changes/${id}/${log.logPath} (${log.logBytes} bytes, sha256 ${log.logHash.slice(0, 12)}...)`));
        }
        if (artifactState) lines.push(kv('Artifacts', artifactState.artifacts.length ? artifactState.artifacts.map(artifact => `${artifact.artifact}:${artifact.status}${artifact.drift ? ` (${artifact.drift})` : ''}`).join(', ') : 'none declared'));
        if (renderRecovery) lines.push(kv('Render recovery', renderRecovery));
        if (recovery) lines.push(kv('Recovery', recovery));
        console.log(box(lines));
      }
      if (result.outcome === 'failed') process.exitCode = 1;
    } else if (command === 'task') {
      if (args.includes('--help') || args.includes('-h')) {
        showCommandHelp('task', `notchlet task <action> [options]

  start <task-name|id> --change <name|id> [--revision <n>]    Start a task
  complete <task-name|id> --change <name|id> [--revision <n>] Complete a task
  complete --all --change <name|id> [--revision <n>]          Complete remaining tasks in dependency order
  update <change-name|id> <task-name|id> <status> [revision] Update a task status

Options:
  --change <name|id>  Change name or ID (required for start/complete)
  --revision <n>    Revision number (defaults to the current revision)
  --force           Allow an out-of-order lifecycle transition
  --require-evidence   Block completion unless current passed evidence references the task
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`);
      }
      const root = await requireWorkspace('task');
      const action = positional[1];
      if (action === 'complete' && args.includes('--all')) {
        const changeRef = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        if (!changeRef) fail('usage_error', usage, 'Provide --change for `task complete --all`.', 64);
        const id = await resolveChangeRef(root, changeRef);
        const localChange = await readChange(root, id);
        const revision = parseRevisionOption('--revision') ?? (localChange.revision ?? 0);
        const result = await completeTasks(path.join(root, '.notchlet', 'changes', id, 'tasks.json'), revision, { requireEvidence: args.includes('--require-evidence') });
        printWithSync(result.change, await syncIfAutomatic(root, id), result.completed.length
          ? `Completed ${result.completed.length} task(s) in ${id} (${result.completed.join(', ')}; revision ${result.change.revision ?? 0}).`
          : `No incomplete tasks remained in ${id}.`, result.warnings);
      } else if (action === 'start' && args.includes('--all')) {
        fail('usage_error', usage, '--all is only supported with task complete.', 64);
      } else {
      let id: string | undefined, taskId: string | undefined, status: string | undefined, revisionText: string | undefined;
      if (action === 'start' || action === 'complete') {
        taskId = positional[2] ?? (isTty() ? await prompt('Task name or ID: ') : undefined);
        id = optionValue('--change') ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        status = action === 'start' ? 'in_progress' : 'completed';
        revisionText = optionValue('--revision') ?? (isTty() ? await prompt('Revision: ') : undefined);
      } else if (action === 'update') {
        [, , id, taskId, status, revisionText] = positional;
        id = id ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        taskId = taskId ?? (isTty() ? await prompt('Task name or ID: ') : undefined);
        status = status ?? (isTty() ? await prompt('Status (pending|in_progress|completed): ') : undefined);
        revisionText = revisionText ?? (isTty() ? await prompt('Revision: ') : undefined);
      }
      if (!id || !taskId || !['pending', 'in_progress', 'completed'].includes(status ?? '')) fail('usage_error', usage, 'Use task start|complete <task-name|id> --change <change-name|id>, or task update <change-name|id> <task-name|id> <status> [revision].', 64);
      if (revisionText !== undefined && !Number.isInteger(Number(revisionText))) fail('usage_error', usage, 'Provide an integer --revision.', 64);
      const changeMatches = await listChanges(root);
      const selectedChange = await pickNamedValue(id, changeMatches, {
        kind: 'Change', promptText: 'Select change',
        label: item => `${item.name} (${item.id})`, keys: item => [item.id, item.name],
      });
      if (!selectedChange) fail('change_not_found', `No change matched "${id}".`, 'Run `notchlet change list` and use a change name or ID.', 2);
      id = selectedChange.id;
      const localChange = await readChange(root, id);
      const selectedTask = await pickNamedValue(taskId, localChange.tasks, {
        kind: 'Task', promptText: 'Select task',
        label: item => `${item.title} (${item.id}) · ${item.status}`,
        keys: item => [item.id, item.title],
      });
      if (!selectedTask) fail('task_not_found', `No task matched "${taskId}" in change "${localChange.name}".`, 'Use a task name or ID from `notchlet change show`.', 2);
      taskId = selectedTask.id;
      const revision = revisionText === undefined ? (localChange.revision ?? 0) : Number(revisionText);
      const transitioned = await transitionTask(path.join(root, '.notchlet', 'changes', id, 'tasks.json'), taskId, status as TaskStatus, revision, { force: args.includes('--force'), requireEvidence: args.includes('--require-evidence') });
      const { warnings = [], ...change } = transitioned;
      printWithSync(change, await syncIfAutomatic(root, id), `Task ${taskId} marked ${status} in change ${id} (revision ${change.revision ?? 0}).`, warnings);
      }
    } else if (['status', 'validate', 'instructions'].includes(command)) {
      if (args.includes('--help') || args.includes('-h')) {
        const helpText = command === 'status'
          ? `notchlet status [change-name|id]

  Show workspace status, or status of a specific change.

Options:
  [change-name|id]  Change name or ID (optional; lists all changes if omitted)
  --history            Include derived verification attempt history and repeated failures
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`
          : command === 'validate'
          ? `notchlet validate <change>

  Validate that a change is ready.

Options:
  <change>     Change name or ID (required)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`
          : `notchlet instructions <change-name|id> [--action <action>]

  Get workflow instructions for a change.

Options:
  <change>     Change name or ID (required)
  --action plan|revise|implement|verify|resume   Action to get instructions for (default: resume)
  --workspace <root>   Set workspace root
  --json               Machine-readable JSON output`;
        showCommandHelp(command, helpText);
      }
      const root = await profileAsync('workspaceResolution', workspace);
      if (!root) {
        if (command === 'validate') fail('setup_required', 'No initialized Notchlet workspace was found.', 'Run `notchlet init` in the project root.', 2);
        print({ coreVersion: CORE_VERSION, workspace: null, changes: [] }, `No Notchlet workspace found. Core engine ${CORE_VERSION}.`);
      } else {
        const changeRef = positional[1] ?? (isTty() ? await prompt('Change name or ID: ') : undefined);
        if (!changeRef) {
          if (command !== 'status') fail('usage_error', usage, `Provide a change name or ID for ${command}.`, 64);
          const changes = await listChanges(root);
          if (json) { print({ protocolVersion: 1, coreVersion: CORE_VERSION, workspace: root, changes }); }
          else {
            console.log(section(`Changes in ${root}`));
            if (changes.length === 0) { console.log(warn('No changes found.')); }
            else {
              const rows = changes.map((c: any) => [c.id, c.name, String(c.taskCount ?? 0), c.ready ? ok('ready') : err('not ready')]);
              console.log(table(['ID', 'Name', 'Tasks', 'Ready'], rows));
            }
          }
        }
        else {
          if (positional.length !== 2 && !(isTty() && positional.length === 1)) fail('usage_error', usage, 'Provide exactly one change name or ID.', 64);
          const target = await resolveChangeTarget(root, changeRef);
          const id = target.id;
          const change = await profileAsync('changeReadAndParse', () => target.archived ? readArchivedChange(root, id) : readChange(root, id));
          const executionDrift = inspectExecutionDrift(change);
          const automaticSync = target.archived ? null : await profileAsync('automaticSyncModeCheck', () => syncIfAutomatic(root, id));
          const contents = await profileAsync('artifactReads', () => artifactContents(root, id, change, { archived: target.archived }));
          if (command === 'status') {
            const facets = await profileAsync('evidenceReads', () => verificationFacets(root, id, change));
            const planInspection = await inspectPlan(root, change);
            const attemptHistory = args.includes('--history') ? await readAttemptHistory(root, id) : undefined;
            const closurePreview = target.archived ? undefined : await previewCapabilityClose(root, id, contents).catch(() => undefined);
            const archivedClosure = target.archived ? await readArchivedClosure(root, id) : undefined;
            const closureInput = closurePreview
              ? { ready: closurePreview.localClosure.ready, blockers: closurePreview.blockers.map(blocker => ({ code: blocker.code, message: blocker.message, recovery: blocker.recovery })) }
              : archivedClosure ? { ready: true, blockers: [] } : undefined;
            const deliveryStatus = closurePreview?.remoteDelivery.status
              ?? (archivedClosure?.remoteDelivery as { status?: 'not_configured' | 'unknown' | 'not_delivered' | 'delivered' } | undefined)?.status
              ?? 'unknown';
            const state = profileSync('evaluateState', () => evaluateState(change, { ...facets, coverageEvidence: coverageEvidenceFrom(facets), remoteDelivery: { status: deliveryStatus } }, contents, closureInput));
            const derivedState = profileSync('deriveState', () => deriveStatus(state));
            const readinessState = profileSync('readinessProjection', () => ({ ready: state.planning.status === 'ready', blockers: state.planning.blockers.map(({ source: _source, ...issue }) => issue) }));
            const recoverable = [...state.verification.missing, ...state.verification.failed, ...state.verification.stale, ...state.verification.unknown];
            const recovery = recoverable.length ? verificationRecovery(id, recoverable) : undefined;
            const pendingTaskEvidence = change.evidencePolicy === 'end-of-change'
              ? (await Promise.all(change.tasks.filter(task => task.status === 'completed').map(task => taskEvidenceStatus(root, change, task.id)))).filter(task => task.status !== 'current')
              : [];
            if (json) { printWithSync({ protocolVersion: 1, coreVersion: CORE_VERSION, change: change.id, revision: change.revision ?? 0, contentRevision: change.contentRevision ?? 0, archived: target.archived, execution: executionMetadata(change), executionDrift, state: derivedState, facets: state, readiness: readinessState, ...(closurePreview ? { closure: closurePreview } : archivedClosure ? { closure: archivedClosure } : {}), ...(planInspection === undefined ? {} : { plan: planInspection, planDrift: planInspection.drift }), ...(attemptHistory === undefined ? {} : { history: attemptHistory }), pendingTaskEvidence, ...(recovery ? { recovery } : {}) }, automaticSync, `${change.name}: ${derivedState}\nCore engine: ${CORE_VERSION}\nEligible tasks: ${state.eligibleTasks.join(', ') || 'none'}\nBlockers: ${state.blockers.length}`, executionDriftWarnings(id, executionDrift)); }
            else {
              const lines: string[] = [];
              lines.push(section(`Status: ${change.name} (${id})`));
              lines.push(kv('Archived', target.archived ? ok('yes') : 'no'));
              lines.push(kv('Revision', String(change.revision ?? 0)));
              lines.push(kv('Content revision', String(change.contentRevision ?? 0)));
              lines.push(kv('Core engine', CORE_VERSION));
              lines.push(divider());
              lines.push(section('Progress'));
              lines.push(kv('Tasks', `${state.execution.completed}/${state.execution.total} completed${state.execution.inProgress ? `, ${state.execution.inProgress} in progress` : ''}`));
              const bases = [...new Set(facets.checks.map(facet => facet.freshness?.basis).filter((basis): basis is 'git' | 'artifact' => Boolean(basis)))];
              const observationBasis = bases.length === 0 ? 'none' : bases.length === 1 ? bases[0] : 'mixed';
              lines.push(kv('Planning readiness', state.planning.status));
              lines.push(kv('Verification', state.verification.status));
              lines.push(kv('Observation basis', observationBasis));
              lines.push(kv('Evidence policy', change.evidencePolicy ?? 'per-task'));
              lines.push(kv('Coverage', `${state.coverage.policy}: ${state.coverage.requirements.covered}/${state.coverage.requirements.total} requirements, ${state.coverage.scenarios.covered}/${state.coverage.scenarios.total} scenarios${state.coverage.complete ? '' : warn(' (incomplete)')}${state.coverage.unlinkedChecks.length ? `; unlinked checks ${state.coverage.unlinkedChecks.join(', ')}` : ''}`));
              lines.push(kv('Execution closure', state.localClosure.status));
              if (executionDrift.status === 'drifted') lines.push(kv('Execution metadata', err(`drifted since recorded — ${executionDrift.recovery}`)));
              lines.push(kv('Close readiness', !state.closure.evaluated ? warn('not evaluated') : state.closure.ready ? ok('ready') : err(`${state.closure.blockerCount} blocker(s)`)));
              lines.push(kv('Remote delivery', state.remoteDelivery.status));
              if (planInspection && planInspection.drift.status !== 'unlinked') {
                const label = planInspection.drift.status === 'none' ? ok('current') : planInspection.drift.status === 'missing' ? warn('missing') : err('drifted');
                lines.push(kv('Plan source', `${planInspection.drift.path ?? '(unknown)'}: ${label}${planInspection.drift.reason ? ` — ${planInspection.drift.reason}` : ''}`));
                lines.push(kv('Plan contract', planInspection.contractSha256));
                lines.push(kv('Plan validation', planInspection.validation.status === 'ok' ? ok('valid') : planInspection.validation.status === 'invalid' ? err(`invalid — ${planInspection.validation.error ?? 'invalid plan'}`) : 'not applicable'));
              }
              if (change.setupCommand) lines.push(kv('Setup command', `\`${change.setupCommand}\``));
              if (change.teardownCommand) lines.push(kv('Teardown command', `\`${change.teardownCommand}\``));
              if (setupAdvisory(change)) lines.push(kv('Setup advisory', warn(setupAdvisory(change)!.message)));
              if (presenceOnlyUiChecks(change).length) lines.push(kv('Presence-only checks', warn(presenceOnlyUiChecks(change).map(check => check.id).join(', '))));
              if (attemptHistory) {
                lines.push(divider());
                lines.push(section('Attempt history'));
                for (const line of summarizeHistory(attemptHistory)) lines.push(bullet(line));
              }
              if (state.verification.missing.length) lines.push(kv('Missing checks', state.verification.missing.join(', ')));
              if (state.verification.failed.length) lines.push(kv('Failed checks', state.verification.failed.join(', ')));
              if (state.verification.stale.length) lines.push(kv('Stale checks', state.verification.stale.join(', ')));
              if (state.verification.unknown.length) lines.push(kv('Unknown checks', state.verification.unknown.join(', ')));
              if (state.verification.current.length) lines.push(kv('Current checks', state.verification.current.join(', ')));
              if (pendingTaskEvidence.length) lines.push(kv('Pending task evidence', pendingTaskEvidence.map(task => `${task.taskId}:${task.status}`).join(', ')));
              if (recovery) lines.push(kv('Recovery', recovery));
              lines.push(bullet('Execution closure means tasks are complete and checks are current; close readiness evaluates capability, artifacts, and planning blockers. Neither implies remote delivery.'));
              lines.push(divider());
              lines.push(section('Eligible tasks'));
              lines.push(state.eligibleTasks.length ? state.eligibleTasks.join(', ') : warn('none'));
              lines.push(divider());
              lines.push(section('Blockers'));
              if (state.blockers.length) for (const b of state.blockers) lines.push(bullet(String(b.message ?? b)));
              else lines.push(bullet('None.'));
              lines.push(divider());
              lines.push(kv('Readiness', readinessState.ready ? ok('ready') : err(`not ready (${readinessState.blockers.length} blocker(s))`)));
              if (state.closure.evaluated && state.closure.blockers.length) {
                const planningMessages = new Set(state.planning.blockers.map(blocker => blocker.message));
                const shownRecoveries = new Set<string>();
                const recoveries = state.closure.blockers.filter(blocker => {
                  if (planningMessages.has(blocker.message) || shownRecoveries.has(blocker.recovery)) return false;
                  shownRecoveries.add(blocker.recovery);
                  return true;
                });
                if (recoveries.length) {
                  lines.push(section('Closure recovery'));
                  for (const blocker of recoveries) lines.push(bullet(`${blocker.code}: ${blocker.recovery}`));
                }
              }
              console.log(box(lines));
            }
            if (profiling) process.stderr.write(`NOTCHLET_PROFILE ${JSON.stringify(profileTimings)}\n`);
          }
          else if (command === 'instructions') {
            const action = optionValue('--action') ?? 'resume';
            if (!['plan', 'revise', 'implement', 'verify', 'resume'].includes(action)) fail('usage_error', usage, 'Choose a documented action: plan, revise, implement, verify, or resume.', 64);
            const [facets, artifactState, closurePreview, archivedClosure] = await Promise.all([
              verificationFacets(root, id, change),
              inspectChangeArtifacts(root, id),
              target.archived ? Promise.resolve(undefined) : previewCapabilityClose(root, id, contents).catch(() => undefined),
              target.archived ? readArchivedClosure(root, id) : Promise.resolve(undefined),
            ]);
            const closure = closurePreview
              ? { ready: closurePreview.localClosure.ready, blockers: closurePreview.blockers.map(blocker => ({ code: blocker.code, message: blocker.message, recovery: blocker.recovery })) }
              : undefined;
            const archived = target.archived ? {
              ...(typeof archivedClosure?.closedAt === 'string' ? { closedAt: archivedClosure.closedAt } : {}),
              ...(typeof archivedClosure?.contribution === 'string' ? { contribution: archivedClosure.contribution } : {}),
              ...(typeof (archivedClosure?.verification as Record<string, unknown> | undefined)?.status === 'string' ? { verificationStatus: (archivedClosure!.verification as Record<string, string>).status } : {}),
              ...(typeof (archivedClosure?.capability as Record<string, unknown> | undefined)?.resultingRevision === 'number' ? { resultingRevision: (archivedClosure!.capability as Record<string, number>).resultingRevision } : {}),
              manifestPath: `.notchlet/archive/${id}/closure.json`,
            } : undefined;
            const text = instructions(change, action as WorkflowAction, { artifacts: artifactState.artifacts, verification: facets, ...(closure ? { closure } : {}), ...(archived ? { archived } : {}) });
            printWithSync({ protocolVersion: 1, coreVersion: CORE_VERSION, action, archived: target.archived, instructions: text }, automaticSync, `Core engine: ${CORE_VERSION}\n${text}`);
          }
          else {
            const result = readiness(change, contents);
            const locationIssues = target.archived ? [] : await diagnoseArtifactLocations(root, id, change);
            const presenceOnly = presenceOnlyUiChecks(change);
            const setupHint = setupAdvisory(change);
            const planInspection = target.archived ? undefined : await inspectPlan(root, change);
            const advisories = [
              ...presenceOnly.map(check => ({ code: 'presence_only_ui_check', checkId: check.id, message: `${check.id}: ${check.reason}` })),
              ...(setupHint ? [{ code: setupHint.code, checkId: setupHint.checkIds.join(','), message: setupHint.message }] : []),
              ...(planInspection?.drift.status === 'drifted' || planInspection?.drift.status === 'missing' ? [{ code: 'plan_drift', message: `Source plan is ${planInspection.drift.status}: ${planInspection.drift.reason ?? planInspection.drift.path ?? 'unknown'}` }] : []),
              ...(planInspection?.validation.status === 'invalid' ? [{ code: 'plan_invalid', message: `Source plan no longer validates: ${planInspection.validation.error ?? 'invalid plan'}` }] : []),
            ];
            const data = { readiness: result, ...(planInspection === undefined ? {} : { plan: planInspection }), ...(advisories.length ? { advisories } : {}), ...(locationIssues.length ? { misplacedArtifacts: locationIssues } : {}), ...(automaticSync ? { automaticSync } : {}) };
            if (json) console.log(JSON.stringify(envelope(result.ready, data, result.ready ? null : { code: 'validation_failed', message: 'Change is not ready.', recovery: 'Resolve the listed blockers and validate again.' }, [])));
            else {
              const lines: string[] = [];
              lines.push(section(`Validate: ${change.name} (${id})`));
              lines.push(kv('Ready', result.ready ? ok('yes') : err('no')));
              if (result.blockers?.length) {
                lines.push(section('Blockers'));
                for (const b of result.blockers) lines.push(bullet(String(b.message ?? b)));
              } else {
                lines.push(bullet('No blockers.'));
              }
              if (planInspection && planInspection.drift.status !== 'unlinked') {
                const label = planInspection.drift.status === 'none' ? ok('current') : err(planInspection.drift.status);
                lines.push(kv('Plan source', `${planInspection.drift.path ?? '(unknown)'}: ${label}`));
                lines.push(kv('Plan validation', planInspection.validation.status === 'ok' ? ok('valid') : planInspection.validation.status === 'invalid' ? err(`invalid — ${planInspection.validation.error ?? 'invalid plan'}`) : 'not applicable'));
              }
              if (advisories.length) {
                lines.push(section('Advisories'));
                for (const advisory of advisories) lines.push(bullet(`${advisory.code}: ${advisory.message}`));
              }
              if (locationIssues.length) {
                lines.push(section('Misplaced artifacts'));
                for (const issue of locationIssues) lines.push(bullet(issue.message), bullet(issue.recovery, '↳'));
              }
              console.log(box(lines));
            }
            if (!result.ready) process.exitCode = 1;
          }
        }
      }
    } else fail('unknown_command', usage, 'Run `notchlet --help` for available commands.', 64);
  } catch (error) {
    if (error instanceof Error && error.message === 'handled') { /* stable error already printed */ }
    else {
      const known = error instanceof WorkflowError ? error : null;
      const code = known?.code ?? 'operation_failed';
      const message = error instanceof Error ? error.message : String(error);
      const recovery = known?.recovery ?? 'Inspect the workspace and retry; existing files were not intentionally overwritten.';
      if (json) console.log(JSON.stringify(envelope(false, null, { code, message, recovery }, [])));
      else console.error(`${err(`${code}: ${message}`)}\nRecovery: ${recovery}`);
      process.exitCode = code === 'change_exists' ? 3 : 1;
    }
  }
}

main().catch(() => {});
