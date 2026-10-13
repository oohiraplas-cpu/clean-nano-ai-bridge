# PR137 CNAI read-only receipt verification

Baseline: `2c312fd131ee9ce981aafe254f5540871c4b22f9` (Draft PR137).

## Changes

The existing `execute_powerplatform_request` accepts `sourceHandoff` for read-only verification. It validates configured repository, canonical branch, safe source path and app/environment; reads the exact current branch head; retrieves content at the immutable commit; recomputes Git blob SHA-1 and content SHA-256; then rereads target and head. Receipt flags cannot grant authority. This route cannot fall through to the mutating orchestrator, and returns `readyForSave:false` and `readyForPublish:false` even after successful source verification.

Fixed P0 evidence `changeHash` validation to require SHA-256 (64 hex), matching atomic reservation. Commit identifiers remain 40 hex. A combined regression verifies that the same change hash passes evidence validation, ETag reservation and approval recheck.

## Local validation

- Full suite: 1,591 passed, 0 failed.
- OpenAPI validation: 1 passed, 0 failed.
- MCP suite: 150 passed, 0 failed.
- Safety suite: 9 passed, 0 failed.
- HTTP and MCP receiver tests run with State Manager enabled, reject forged/stale/conflicting receipts and publication approval, and verify absence of mutation calls.
- `git diff --check`: clean.

Tests use fixtures; they are not live Microsoft execution evidence. CI for the final commit is recorded in the PR body.

## Unverified / BLOCKED

Source verification proves repository bytes only, not that the canvas app has saved those bytes. Native Git solution binding, verified backup, App Checker, independently authenticated human approval and bound single-use save execution remain required. The P0 runtime mutation helper is not yet wired to atomic reservation; legacy individual write routes and caller-provided approval flags require further audit before activation. A source write to the configured main branch can indirectly trigger Azure deployment, despite deferred direct Power Platform synchronization.

No production API mutation, main merge, publication, deployment, permission change or paid resource creation was performed for this change. New receiver behavior is Draft code and is not installed in the live Bridge.
