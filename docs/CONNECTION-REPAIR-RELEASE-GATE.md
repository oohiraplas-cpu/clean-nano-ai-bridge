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
