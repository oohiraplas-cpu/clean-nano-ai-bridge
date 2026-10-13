# PR #137 — Approval contract and CI compatibility (Draft only)

## CI evidence
- Push workflow run #1067 (38306236479), HEAD edb2052fb06625374c5f52601a7056ddbca2afb5: FAILURE at `6. Run test suite`.
- Observed failures: `publishGate.test.js:189`; legacy `server.test.js` success expectations for save/update/publish and `deferSync`.
- The direct mutation guard intentionally returns BLOCKED. Legacy success tests do not establish authorized write behavior and MUST NOT be restored by bypassing the guard.
- `deferSync` still issues a GitHub PUT (not a read-only handoff). Keep blocked until a separate, proven read-only path is used.
- CI runs on `push: ['**']`; `pull_request` is restricted to main/develop. Check push runs, not only PR-filtered workflow queries.

## Separate approval contracts (not interchangeable)

| Concern | `approvalLedger.js` | `atomicApprovalReservation.js` |
|---|---|---|
| Data source | Injected `fetchRows` with configured `siteId`, `listId`, internal `fieldMap` | Injected `store.assertConfigured/read/patch/verifyHuman` |
| Approval key | `requestId`, `stepIndex`, `tool` | `approvalId`, `requestId`, `tool` |
| Target binding | `targetSha`, `environmentId`, `appId`, `changeHash`, `approvalStage` | `commitSha`, `environmentId`, `targetId`, `diffHash` |
| Approver | `approver` text | `approverId` plus independent `verifyHuman` |
| Lifetime | approvedAt up to 24h | approvedAt/expiresAt, max 24h |
| Single-use | No reservation | ETag If-Match patch + executionId + consumed local receipt |
| Revocation | Checks `revoked` | Fresh read + ETag + revoked + directory recheck |

## Required integration proof before enabling mutations
1. Read actual SharePoint site/list IDs and internal column names. Do not create, rename, or delete existing lists.
2. Implement a single explicit mapping with verified schema and immutable operation/target/SHA/diff binding; reject ambiguous approvals.
3. Verify the original human approver via independent directory/allowlist read before and after reservation. Do not rely on the service actor's lastModifiedBy.
4. Prove Graph ETag If-Match compare-and-set and post-patch reread, no retries on 412/uncertain writes.
5. Inject verified SHA reader, backup, postcondition and human-approved recovery. Confirm all server mutation routes share the same gate.
6. Replace outdated success tests with negative tests for unapproved writes; preserve independent read-only CNAI source handoff tests. Do not merely skip failing tests.
7. Run npm test, OpenAPI, MCP and safety checks on the Draft HEAD; retain the direct guard until all are PASS.

**Current status: BLOCKED.** This document does not assert production connectivity, test success or permission to deploy.
