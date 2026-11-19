# Fixture: multi-task story

## Request

Add a status-and-text filter to the backlog list. Selected filters remain visible after refresh, no-match state is clear, and clearing filters restores the full list.

## Acceptance checks

1. Status and text filters can be combined and the result set matches both conditions.
2. Filter selection is encoded in the URL and restored after refresh.
3. No matches render an explicit empty state; clearing filters restores the list.
4. Backend and frontend tests cover filtering, URL restoration, empty state, and clear behavior.

## Stable task IDs and dependencies

| ID | Task | Depends on |
| --- | --- | --- |
| T1 | Define query parameters and API validation | none |
| T2 | Implement backend filtered query | T1 |
| T3 | Add frontend filter controls and URL restoration | T1 |
| T4 | Add integration and component tests | T2, T3 |
