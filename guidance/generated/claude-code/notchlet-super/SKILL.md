---
name: notchlet-super
description: Route a Notchlet development request from current workspace state; resume existing work without restarting setup or planning.
---

# Notchlet Super — state-aware router

Use this skill to route a request to the smallest relevant Notchlet action. Read current state first; do not replay a generic six-phase setup for every request. The local CLI manages local `.notchlet` change records and synchronized snapshots; MCP tools access authorized server state. Keep those state boundaries clear. Ask only for material decisions or actions that need user authorization.

## Route from the user's intent

- **Explore / investigate (read-only):** inspect the checkout, tests, docs, git state, and relevant bounded MCP context. Do not run `notchlet init`, create/convert a change, edit files, transition tasks, sync, checkpoint, or write backlog state. Exploration works without an initialized `.notchlet` workspace; for local state use `notchlet status` or `notchlet change list` only when useful (both report empty state when no workspace exists).
- **Plan only (read-only unless asked to persist):** use `notchlet-plan` to clarify outcome, scope, assumptions, dependencies, risks, and verification criteria in the conversation. Planning does not require initialization, an epic→story→task hierarchy, or application/change-artifact writes. Existing server-side planning may use bounded read tools (`notchlet_workspace_context`, `notchlet_workspace_search`, `notchlet_backlog_get`, `notchlet_backlog_list`, `notchlet_backlog_development_context`, and `notchlet_document_list/get`); do not create/update items unless the user asks. `notchlet instructions <change> --action plan` is available only for an existing local change and is informational; it is not required for planning.
- **Revise:** distinguish revising a proposed plan (keep it read-only unless persistence is requested) from revising an existing local change. For the latter, inspect it with `notchlet change show <id>`, `notchlet status <id>`, and `notchlet instructions <id> --action revise`; preserve stable IDs/progress, edit only requested artifacts, then run `notchlet validate <id>`. The `instructions` action itself is read-only.
- **Implement:** first confirm scope, requirements, repository, branch, and user edits; read `notchlet status <id>` and `notchlet instructions <id> --action implement` when an existing change applies. Follow `notchlet-implement`; run only relevant project checks and record actual outcomes. Use `notchlet task start <task-id> --change <id> --revision <revision>` and `notchlet task complete <task-id> --change <id> --revision <revision>` for dependency/revision-checked local transitions; do not mark complete before evidence exists. `notchlet task update <change> <task> <status> <revision>` remains available for explicit transitions to any supported task state.
- **Verify:** use `notchlet instructions <id> --action verify`, `notchlet validate <id>`, and actual repository test/check commands appropriate to the change. Record bounded results with `notchlet evidence record --change <id> --file <evidence.json>`; any `command` field is descriptive and never executed. Link required checks with their IDs in `checkIds`. A successful readiness validation is not a substitute for tests. Keep failed and unrun checks distinct; do not claim verification without observed results.
- **Continue / resume:** locate current state with `notchlet status [<change>]`, `notchlet change list`, and, for a selected change, `notchlet change show <id>` plus `notchlet instructions <id> --action resume`. Continue only eligible work, preserve existing artifacts/user changes, and do not recreate valid plans or restart setup.
- **Review:** use `notchlet-review`; distinguish a self-recorded check from independent human review.
- **Deliver:** use `notchlet-deliver` after implementation, verification, and required review. `notchlet checkpoint --change <id> --name <name>` records a synchronized checkpoint; `notchlet sync status|push|pull --change <id>` inspects or explicitly synchronizes snapshots, and resolve only after reviewing divergence. Server delivery can be evaluated with `development_delivery_create` only when explicitly authorized and with its required idempotency/revision fields. A branch-linked item requires the exact linked PR/MR to be merged and approved before a `DONE` status request. Delivery evaluates existing provider state; it does not merge or deploy.

## Reuse current workspace and connection

1. Use the nearest initialized `.notchlet` workspace or the user's explicit `--workspace <path>` for change-oriented commands. Exploratory and conversation-only planning do not require one.
2. If there is no initialized workspace, local reads are side-effect free. Run `notchlet init` only when a requested local change workflow actually requires it and the user approves it; do not assume a separate bootstrap command exists. Never initialize just to explore or plan.
3. For connected work, use `notchlet doctor` to test authenticated capabilities and identity. Do not probe `/mcp` with an unauthenticated `GET`; Notchlet MCP uses authenticated Streamable HTTP `POST` requests.
4. Do not transfer numeric product IDs between servers. Rebind only after confirming the intended server/product/repository identity.
5. Fetch bounded context for the selected backlog item when one is relevant; never dump the entire product to find one item. Missing item/product identity is not a reason to turn an exploratory or local planning request into a backlog hierarchy.
6. If MCP credentials or connection settings are genuinely missing, use `notchlet-mcp` to configure and verify them; otherwise skip setup and reuse the working binding.
7. If the requested backlog item or product is not yet identified, use `notchlet-platform`; if the identity is already confirmed, reuse it instead of searching again.

## State-aware MCP tool calls

The local Notchlet MCP registry exposes these concrete tool names and arguments; use the connected server's `tools/list` schemas as authoritative. Some hosts wrap tool names with a `notchlet_` prefix; call only the exact names actually advertised, and do not assume the new development tools are deployed on every server:

- `backlog_development_context({ itemId, section?, cursor?, knownFingerprint?, limit? })` for one bounded item context.
- `development_changes_list({ productId?, limit?, cursor? })` and `development_change_get({ changeId })` to discover/read changes.
- `development_instructions_get({ changeId, action, snapshotRevision?, context? })` for server-evaluated instructions tied to a synchronized revision; actions are `plan`, `revise`, `implement`, `verify`, and `resume` and require an existing authorized change.
- `development_delivery_create({ changeId, expectedRevision, operationId, payloadHash, snapshotRevision, target, backlogStatus?, repositoryRef?, summary? })` for an explicit, idempotent delivery evaluation. `backlogStatus` additionally requires `backlog:write`; query the operation after an uncertain response and use a new operation ID only for a new attempt.

The REST API and MCP tools call the same `DevelopmentService`; preserve their expected revisions, operation IDs, payload hashes, scope checks, and error recovery semantics. Do not infer that remote snapshot state represents unsynchronized local edits.

## Authorization and handoff

- Preserve explicit authorization boundaries. Never push, open/merge a PR, deploy, publish skills, or change remote status merely because a task is complete.
- Use `notchlet sync status|push|pull --change <id>` for explicit snapshot synchronization. Divergence requires review; use `notchlet sync resolve --change <id> --keep-local` only after reviewing the local artifacts, then retry conditionally.
- `notchlet checkpoint --change <id> --name <name>` records a synchronized checkpoint; it is not delivery evidence by itself.
- Local verification, local closure, remote delivery, merge, and deployment are separate outcomes. Never describe merge as deployment or a requested status as successful until the service response confirms it.
