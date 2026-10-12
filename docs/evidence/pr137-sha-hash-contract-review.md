# PR #125 / #137 approval SHA and hash contract — Draft review

Status: BLOCKED; no mutation route enabled. This is a proposed compatibility contract, not implementation or live validation.

## Distinct SHA domains

- `bridgeRuntimeSha`: immutable 40-hex SHA of the **actually deployed Bridge code**. PR #125 `ScopedApprovalExecutor.validate` calls this `commitSha` and compares it to the trusted server `commitSha`.
- `powerAppsSourceSha`: independently retrieved 40-hex immutable Power Apps target/source revision (or another explicitly documented native target version). PR #137 currently calls this `targetSha` and checks `readCurrentSha(scope)`.
- These values must not be implicitly aliased or assumed equal. Existing PR #125's 15-field record has only one `commitSha` column; it cannot attest both domains without an explicit additional immutable binding (e.g. separately verified scope payload hash including powerAppsSourceSha) and clear meaning of `commitSha`.
- Do not repurpose `commitSha` silently. Existing approval records must be invalidated or migrated only with a new human approval if the contract changes.

## Hash domain

- PR #125 `changeHash(input)` is SHA-256 over canonical JSON of `{requestId,tool,targetId,environmentId,commitSha,params}`, with lexically sorted object keys.
- PR #137 `changeHash` in the gate is a caller-supplied 64-hex value; `atomicApprovalReservation.js` only compares it to `record.diffHash`. It does **not** independently recompute the canonical payload digest.
- Matching 64-hex syntax is insufficient. The server must compute the exact canonical digest from trusted operation parameters, Bridge runtime SHA, Power Apps target SHA, target/environment IDs and the operation-specific approved diff, then compare to the ledger. This requires a versioned, explicitly reviewed canonicalization contract.
- A separate human approval is required for update, save and publish; an approval for one operation must not authorize another.

## Test acceptance (Draft only)

1. A record matching Bridge SHA but not Power Apps source SHA is denied; likewise reverse.
2. Changed canonical parameters, target ID, environment, operation, approval stage or source SHA changes the digest and denies reservation.
3. Human approvedAt/expiresAt, revoked=false, Entra actor and allowlist are checked before atomic ETag reservation and again before mutation.
4. Parallel reservations: exactly one succeeds; Graph 412 and uncertain writes never retry.
5. Final recheck consumes receipt exactly once; restart, revocation, ETag changes or identity disablement deny.
6. No direct update/save/publish route is enabled until trusted runtime SHA and source SHA readers, backup and postcondition adapters exist and all tests pass.

No SharePoint list, permissions, Azure settings, main branch, or production Power Apps resources were modified.
