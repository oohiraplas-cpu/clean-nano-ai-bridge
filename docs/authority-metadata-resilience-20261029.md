# AuthorityContext / Git metadata resilience — repair contract

## Observed failure
On 2026-10-29, Bridge MAX get_powerapps_state failed with `AuthorityContext hydration failed: Git metadata unavailable`, while authenticated GitHub fetch_file of src/server.js and src/stateContext.js on main succeeded. This does not prove the deployed bridge uses the same code or credentials.

## Non-negotiable behavior
- Do not bypass Git metadata, fabricate SHA, use stale cached authority, or allow writes when source cannot be bound to a verified immutable commit.
- Separate failure categories: credentials (401/403), missing repo/path/ref (404), rate limits (429), network/timeout (retryable), malformed response, scope mismatch, stale session, and deployment mismatch.
- Resolve immutable repository/branch HEAD and required source blob SHA using one consistent GitHub identity and explicitly configured repository. Verify the resolved gitRoot exists. Never silently fall back to another branch.
- Retry only transient network/429/5xx with bounded exponential backoff and jitter; respect Retry-After; never retry auth/scope/404 errors blindly.
- StateContext registry: retain server-side scope, environment, appId, repository, gitRoot, immutable SHA, correlationId and session ID; require exact equality for all subsequent calls. A process restart or instance switch must reject old sessions until a trusted shared store is available.
- Never return status ok if any requested screen failed. Mark partial/error, successCount, failureCount, and per-screen causes.
- Diagnostics at startup and per operation should expose only nonsecret metadata: configured repo/ref, endpoint reachability, error class, correlationId, deployed revision, and freshness. No token logging.
- WRITE gates: require verified source, fresh snapshot with independently tested restore, approval ledger, licensing/DLP check, Power Apps checker, post-save reread, and post-publish verification. Any missing proof => BLOCKED.

## Acceptance tests
1. Valid Git metadata + same scope => successful READ and source observation.
2. Missing Git metadata => explicit BLOCKED, no mutation.
3. 401/403/404/429/timeouts => classified correctly; only transient errors retried.
4. Mismatched branch, app, environment, repository, gitRoot, SHA, session, or expired TTL => fail closed.
5. Two-screen READ with one failure => partial, never ok.
6. Concurrent sessions, process restart, registry exhaustion => safe rejection.
7. Azure deployed revision differs from reviewed Git revision => no WRITE.
8. Existing application operations and 98 registered MCP capabilities remain compatible.
9. All regression tests pass on a dedicated branch; PR reviewed before merge/deployment.

## Status
Design/acceptance contract only. Not a code fix, not deployed. No Power Apps changes or publication.
