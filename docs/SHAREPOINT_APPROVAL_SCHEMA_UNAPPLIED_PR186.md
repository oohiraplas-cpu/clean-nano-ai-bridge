# SharePoint approval ledger: verified READ and UNAPPLIED schema proposal

Status: UNAPPLIED. No SharePoint list/column/ACL changes; no production WRITE enabled.

## Observed 2026-10-25 (READ)
- Site: https://hisyoengineer.sharepoint.com/sites/cleannano
- 59 lists returned by Microsoft SharePoint Graph read.
- CN_AI依頼台帳 list GUID: 973f17d6-3566-4795-9712-2386bb7bf540
- Existing internal names: Title (依頼ID), RequestDateTime (依頼日時), Requester (依頼者), RequestContent (依頼内容), AIRequestStatus (状態), _x627f__x8a8d__x72b6__x614b_ (承認状態), _x627f__x8a8d__x8005_ (承認者), _x627f__x8a8d__x65e5__x6642_ (承認日時).
- CN_AI監査台帳 GUID: 32585e7f-200d-45da-a51a-3c68bc3b2394; columns include ExecutionDateTime, Executor, ProcessDetails, Result, Status.
- CN_AI権限台帳 GUID: 3c0fe882-160b-47d0-84ec-ae81cdfa0d7c; no dedicated approval binding columns observed.
- No independent operation/paramsDigest/scope/environment/resource/revoked/stepIndex columns observed on these lists.
- No effective ACL evidence acquired. Do NOT infer AI cannot edit approvals from column schema.

## Minimal additive columns proposed for CN_AI依頼台帳 (NOT created)
| Proposed internal name | Type | Meaning |
|---|---|---|
| CNApprovalStepIndex | Number (integer) | Immutable approval step |
| CNApprovalTool | Single line text | Exact MCP tool |
| CNApprovalOperation | Single line text | Exact WRITE operation |
| CNApprovalParamsSha256 | Single line text (64 hex) | Canonical parameter digest |
| CNApprovalScopeFingerprint | Single line text | Hash of server-bound credential scope; never store bearer secret |
| CNApprovalEnvironmentId | Single line text | Exact environment |
| CNApprovalAppId | Single line text | Exact target app (for Power Apps) |
| CNApprovalResourceKind | Single line text | powerapps-screen/list/flow/etc |
| CNApprovalResourceId | Single line text | Exact resource ID |
| CNApprovalStateSha | Single line text (40 hex) | Observed immutable state/source SHA |
| CNApprovalRevoked | Yes/No | Revocation |
| CNApprovalRequestId | Single line text | Stable request identifier if Title is not sufficient |
| CNApprovalNonce | Single line text | Replay protection/idempotency |
| CNApprovalExpiresAt | Date/time | Explicit validity bound |

Before applying, verify SharePoint internal names, supported field types, uniqueness/index requirements, ACL isolation, versioning, row-level access, approval authority and human-only edit access. Never add columns or relax permissions automatically.

## Minimal code diff specification (UNAPPLIED)
1. approvalLedger.js: extend fieldMap explicitly (no guessed internal names), normalize all binding fields, require exact expected values, reject null/unknown/multirow conflicting approvals, revoked/expired/changed version. Preserve existing API via opt-in strict method; do not silently alter legacy behavior.
2. unifiedWriteGateMock.js: replace mock evidence callback only after authenticated server-side SharePoint READ adapter verifies list GUID, row identity, ETag and human editor, with immutable operation/parameter digest and target binding. No caller-provided approval row or scope.
3. stateContext.js: use server registry TTL, credential scope, observed source, branch and target checks; design separate authority observations for SharePoint and Flow. Reject using Power Apps state as unrelated resource authorization.
4. platformManage.js/server.js: KEEP existing WRITE denial until strict adapter, permission audit, rollback snapshot, premium scan, E2E tests and explicit human deployment approval all PASS.
5. Tests: missing/duplicate/altered approval, stale ETag, revoked, expiry, cross-scope/cross-env/cross-resource, replay, SHA mismatch, unknown premium connectors, API failure, and positive synthetic path without real mutation.

## Deployment decision
BLOCKED until all schema/ACL/permission evidence and separate user authorization for production changes. Draft PR #186 only; no main merge, publish, premium usage or additional charges.

## 2026-10-25 effective ACL READ audit — BLOCKED

Live Microsoft SharePoint Graph get_site and list_site_lists confirmed CN_AI依頼台帳 is a genericList at list GUID 973f17d6-3566-4795-9712-2386bb7bf540, URL https://hisyoengineer.sharepoint.com/sites/cleannano/Lists/CN_AI.

The available SharePoint connector list_item_permissions is **drive-item/file-only**, not a SharePoint list permission API. Its results cannot establish this genericList's inheritance, role assignments, item-level permissions or actor-specific effective rights. The Bridge MAX sharepoint_manage.get operation exposes list metadata and columns, not effective ACL. No list permission endpoint was called, and no write-based permission probe was attempted.

Evidence still required:
1. List HasUniqueRoleAssignments and parent web inheritance state (read-only).
2. Complete role assignments including SharePoint groups, Entra security groups, nested membership, Limited Access, site owners and service principals; resolve effective rights rather than group names alone.
3. Explicit **non-edit** proof for ordinary employee account(s), the Bridge/Azure managed identity, Copilot Studio connection identity, Power Automate run-only/owner identities and other AI execution principals; include their effective role, list permissions and any app-only Graph permission paths.
4. Confirm authorized human approvers alone can create/modify approval evidence, and no ordinary user can self-approve by editing approval fields on CN_AI依頼台帳.
5. Check item-level role inheritance, list form/flow mutation paths, audit/version history and whether approver identity comes from a trustworthy Entra claim.
6. Collect sanitized evidence with observation time, principal IDs (redacted where appropriate), site/list GUID, inheritance flags and permissions; do not expose secrets or modify ACL.

Decision: approval tamper prevention BLOCKED; central WRITE remains fail-closed. If approval fields on CN_AI依頼台帳 can be modified by ordinary requesters, the ledger MUST NOT treat them as an independent human approval source. Prefer a separately protected approval list or segregated immutable approval records only after human-authorized ACL design; no automatic creation.

## ApprovalLedger alignment (source review)
- Existing required fieldMap keys: requestId, stepIndex, tool, status, approver, approvedAt, revoked.
- CN_AI依頼台帳 currently has Title (request ID candidate), approval status, approver, approval datetime; **no verified dedicated stepIndex, tool, revoked or strict target/digest binding columns**.
- Existing ApprovalLedger.check accepts the first valid record among multiple rows. Before production strict approval, reject ambiguous/conflicting duplicate approvals and bind evidence to one immutable row/version/ETag.
- Strict mock additionally checks operation, params SHA-256, credential scope, environment, appId, source SHA and resource kind/id, but it is NOT connected to live SharePoint and is NOT an authorization gate.
- Never treat `approvedByHuman`, client-supplied `binding`, client-supplied `scope` or an unverified fetch callback as sufficient authorization.
