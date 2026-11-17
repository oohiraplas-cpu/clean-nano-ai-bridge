# PR #263 — Release safety, audit and recovery gate

## Verified scope
- Read-only connection diagnostics and Microsoft/Azure probe adapter interface.
- Explicit scoped approval validation, fail-closed unknown action/identity/expiry.
- Transactional store interface with compare-and-swap, tested using a mock store.
- No live Azure/Microsoft 365 mutation, no secret rotation, no production endpoint wired.

## Release checklist (all required for COMPLETE)
1. Identify production app, runtime SHA, environment and owner. Capture current configuration metadata, excluding secrets.
2. Confirm existing Microsoft Graph/Entra OAuth or managed identity permissions with least privilege. No premium licenses or new resources.
3. Select an existing durable transactional store, confirm actual schema, permissions and atomic conditional update. Do not use the process-local Map for production approvals.
4. Bind pending approval to authenticated principal and exact service/action/target/expiry; atomically consume once.
5. Implement provider-native secure repair with snapshot, dry-run, verify and rollback. Do not log or return secret values.
6. Independent normal/abnormal tests: 401/403, expired approval, replay, concurrency, provider timeout, failed rollback, missing permission and secrets masking.
7. Confirm live E2E and read-back, audit log, recovery rehearsal, production SHA and zero unexpected costs.
8. Only then request a single scoped release approval and deploy.

## Recovery
- Before change: capture last known good commit, deployment ID, configuration names (never values), permissions and relevant resource identifiers.
- If deployment validation fails: stop writes; restore the last known good deployment through existing deployment pipeline, verify health, and record audit evidence.
- If credential rotation fails: keep the old credential active until replacement is independently verified; never revoke first. Revoke only after explicit approval and verification.
- If approval store is unavailable or CAS fails: fail closed, do not execute privileged writes. Resume from checkpoint after store recovery.
- If rollback cannot be independently verified: mark BLOCKED and escalate a single concrete human action.

## Status
Code/CI may pass while provider integration remains BLOCKED. No production publication or auto-rotation is authorized by this document.

## Independent source audit findings (2026-11-17)
- connectionRepairOrchestrator accepts request-supplied approved and approvalScope. This is not authenticated production approval. Never connect production mutation to these flags.
- durableConnectionApproval uses an injected CAS interface, not a real store or authenticated identity attestation. Target binding and actual secure write are absent.
- connectionProviderAdapters uses injected probes, not provider-native live API clients. HTTP 200 alone is not PASS without authorized operation. Probe timeouts now fail closed.
- These are release blockers even when CI passes.

## Authenticated approval boundary update
- authenticatedConnectionApproval accepts only a principal returned by injected trusted auth middleware, not a request-supplied subject ID. It requires verified=true, nonempty issuer, tenantId and subjectId. Unit tests cover spoofing, auth errors and fail-closed behavior.
- IMPORTANT: no actual Entra token validation or trusted middleware is wired here. The injected resolver must independently validate token signature, issuer, audience, tenant, expiry and session before setting verified=true. Do not treat an arbitrary resolver or boolean as proof of identity.
- Production release remains BLOCKED pending trusted auth middleware, real transactional store, and verified provider-specific adapters.

## Existing asset reuse investigation
- Existing src/recoveryOAuth.js validates Entra JWT RS256 signature against Microsoft signing keys, issuer, audience, tenant, client, fixed user, scope and expiry. Added verifiedPrincipal() that returns identity only after authorized(token) passes. Added read-only recoveryPrincipalResolver and negative tests.
- Existing src/approvalLedger.js is SharePoint READ-ONLY approval verification, and src/sharePointTaskStore.js uses Graph client credentials. Neither provides a production atomic approval compare-and-swap; do not repurpose either as durable single-use store without validated list schema, ETag concurrency, permissions and authenticated identity binding.
- New resolver is not mounted in production Express middleware; trustedMiddleware flag is an integration contract, not proof by itself. It must only be set by server-owned middleware after secure bearer extraction. Do not accept this flag from HTTP request JSON.
- Existing recovery auth is scoped to a fixed user and mcp.access. Do not broaden to other users/scopes without explicit permission and test.

## SharePoint ETag CAS adapter (isolated, not deployed)
- sharePointApprovalCasStore requires explicit verified fieldMap and injected fetchItem/patchItem. Conditional PATCH must be implemented with SharePoint If-Match header; HTTP 409/412 is treated as a lost race, other failures fail closed. Mock concurrency tests are present.
- Existing approvalLedger is read-only and cannot be assumed to contain the required fields. No production list schema or unique RequestId constraint was verified; do not wire adapter until those are checked.
- ETag CAS prevents concurrent updates to one item, but duplicate rows with the same requestId require a unique constraint or an explicit duplicate-detection fail-closed fetchItem implementation.
- The adapter has no production Graph HTTP implementation, verified authenticated principal binding, or rollback-capable repair adapter. CI success is not live E2E.

## Graph transport implementation and live schema blocker
- src/graphApprovalTransport.js is an injected Microsoft Graph transport for GET with escaped OData requestId filter, strict duplicate/nextLink rejection, and PATCH with If-Match ETag; no production endpoint or token configured. Test mocks only.
- Live approval list site hostname/path, list GUID, internal column names, indexed unique requestId constraint, and ETag behavior have not been verified. SharePoint connector needs a concrete site path to enumerate lists. Existing src/approvalLedger.js only has a configurable fieldMap, not an actual site reference.
- The transport's fetchItem/patchItem must be wired only after live read-only schema inspection and a dedicated approval list is confirmed. Graph permissions and actual conditional-write E2E remain BLOCKED.
