# PR #137: human identity, ETag reservation and lifecycle audit

Starting HEAD: `e5d4f6045bf99ca95b1827427ccb90b2da6b6c9c`.
Branch: `draft/orchestrator-p0-gate-20261013`; PR remains Draft, stacked on PR #134.
Scope: repository-only changes and mocked/local verification. No live write, merge,
deployment, permission change, secret retrieval or additional paid service.

## Verified baseline CI

Push CI #1051 / run 38296561364, job 114968928371, exact starting HEAD: SUCCESS.
The PR-only workflow lookup returned no runs because this stacked base is outside
`pull_request.branches`; the push workflow supplies the actual evidence.
Downloaded job logs confirm the service-actor regression (`ok 36`), npm tests
1567/1567, OpenAPI 1/1, MCP contract 148/148 and safety 9/9. All have zero failures.
URL: https://github.com/oohiraplas-cpu/clean-nano-ai-bridge/actions/runs/38296561364

## Minimal identity and reservation repair

`atomicApprovalReservation.js` keeps the original authenticated Graph-origin
snapshot in a private WeakMap keyed by the trusted store and random execution ID.
It is never returned to clients or reconstructed from caller-provided flags.
The original approver ID and all decision/scope/lifetime fields are pinned by a
SHA-256 fingerprint before the conditional reservation PATCH.

The injected `verifyHuman` must independently check the original Graph actor
against the allowlisted approver and freshly query directory account status on
EVERY call. The PR #125 store contract does this; it is not present or wired in
this branch. A verifier tied to mutable current lastModifiedBy remains rejected.
Fresh directory verification uses the retained original human snapshot, so the
reservation's service lastModifiedBy is never interpreted as the approver.

Post-reservation read must show a new concrete ETag, exact decision fingerprint,
execution ID and reserved status. Final recheck requires that ETag and a live
human check, then reads again to detect ledger edits during the directory query.
The private receipt is consumed synchronously after awaited reads, so concurrent
rechecks cannot both authorize. ETag conflicts and uncertain outcomes are never
retried. Restart/another store instance loses the receipt and denies execution;
the durable SharePoint reservation remains consumed. No new list/column required.

This is process-local proof continuity, NOT a durable independent approval-event
archive. Restart recovery deliberately requires a new human approval. A trusted
snapshot reader, verified Graph identity metadata, allowlist and directory-read
access remain prerequisite. There remains a small interval between the final
ledger read and target API call; cross-service atomic cancellation is not claimed.

## Lifecycle API audit at starting HEAD

| Path | Existing behavior | Current disposition / remaining gap |
| --- | --- | --- |
| PowerAppsStore.updateApp | Dataverse PATCH limited to description/commitMessage | Does not edit canvas screen source; lifecycle approval migration unverified |
| PowerAppsStore.saveApp | Reads current state and records local operation success | No canvas persistence API; cannot prove saving changed canvas source |
| PowerAppsStore.publishApp / server publish route | Actual management publish POST; session, branch, commit/blob, target and deployment SHA checks | Independent approval ledger, single-use reservation and publication readback not unified across this legacy path |
| PowerAppsExecutionAdapter | Some screen methods attempted Git writes before unsupported canvas update; save/publish returned placeholder success | Unsupported editing/save/publish/checker operations now return blocked without API calls |
| PowerAutomateRunner / server run route | Registered HTTP trigger POST, caller approvedByHuman flag | Run initiation only, not flow edit/save/enable/publication or confirmed run completion; ledger migration remains missing |
| PowerAutomateExecutionAdapter | Flow editing methods returned constructed objects as success; missing runner could succeed | Unsupported edit/history/result paths now blocked; missing runner blocked; real configured runner result preserved |
| SharePointListWriter / server individual write routes | Actual Graph POST/PATCH; caller approval flag | Conditional target ETag, immutable scoped approval, backup/readback and durable audit not unified here |
| SharePointExecutionAdapter | List/item mutations returned constructed success; schema check only compared column count | Unsupported mutation/schema verification now blocked without API calls |
| executeP0Mutation helper | Ledger/evidence and fresh HEAD, then injected perform callback | No atomic reservation/recheck in this helper; runtime is unconfigured and remains BLOCKED for activation |
| PlatformOrchestrator | Bound ledger/evidence, reservation, fresh HEAD, final approval recheck | Live evidence/store providers still absent; deploy/publish outcomes require stronger independent verification |
| PR #125 scoped SharePoint executor | Separate Draft implementation, exact target/fields/hash, Graph identity, ETag, backup, readback, durable outcome | Not merged into #137; migration/reconciliation mandatory, no blanket approved execution claim |

## Local validation of this change

Node v24.19.0. Focused identity/lifecycle tests: 23 PASS / 0 FAIL.
Full npm suite: 1578 PASS / 0 FAIL. OpenAPI: 1 PASS / 0 FAIL.
MCP suite: 148 PASS / 0 FAIL. Safety suite: 9 PASS / 0 FAIL.
OpenAPI/MCP/safety were run after adapter changes; subsequent changes only consume
the private final-recheck receipt and add two focused identity tests. Full suite
was rerun after those changes. New exact-HEAD GitHub CI must be verified separately;
baseline #1051 is not evidence for this new tree.

## UNVERIFIED / BLOCKED and next work

No live approval-list ID, column mapping, allowed human, Graph permissions, ETag
semantics or runtime store wiring was verified. No App Checker run, live backup,
canvas save, flow definition edit, SharePoint target write or publication occurred.
These remain BLOCKED, not PASS. Main merge and production changes are prohibited.

Next: verify new exact-HEAD CI; reconcile PR #125's store/operation registry with
#134/#137; migrate legacy individual writes and the P0 helper to the same scoped
single-use gate; replace unsupported lifecycles with existing verified APIs only
when actual target/auth/schema and independent post-operation evidence are known.
