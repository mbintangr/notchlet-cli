# Fixture: small fix

## Request

When a display-label helper receives an empty or whitespace-only string, return `Untitled`. Preserve existing behavior for non-empty labels.

## Acceptance checks

1. An empty string and a whitespace-only string both return `Untitled`.
2. A non-empty input still returns its normalized display label.
3. Add focused unit coverage and run the relevant package test.

## Scope boundary

Do not change persistence, API contracts, or unrelated formatting behavior. The backlog item is already identified and its acceptance criteria are complete.
