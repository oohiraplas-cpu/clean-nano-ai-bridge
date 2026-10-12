# CN_承認管理台帳 — Draft schema and access contract

Status: DESIGN ONLY. The list does not exist. No production creation, permission grant or deployment is authorized.

Site: https://hisyoengineer.sharepoint.com/sites/cleannano
Proposed list display name: CN_承認管理台帳
Internal names below are **proposed**, not observed Graph metadata. Create with stable ASCII internal names; re-read actual Graph columns before setting any environment variable. Preserve the default SharePoint Title/ID/Created/Modified columns.

| Logical key | Proposed internal name | SharePoint type | Constraints |
|---|---|---|---|
| requestId | requestId | text (single line) | required nonempty |
| tool | tool | text (single line) | required; allowlisted operation |
| targetId | targetId | text (single line) | required; canonical target |
| environmentId | environmentId | text (single line) | required |
| commitSha | commitSha | text (single line) | required; 40 lowercase hex; **running Bridge SHA**, not canvas source SHA |
| diffHash | diffHash | text (single line) | required; 64 lowercase hex |
| approverId | approverId | text (single line) | required; Entra object ID, not person column |
| approvedAt | approvedAt | dateTime | UTC; required on approval |
| expiresAt | expiresAt | dateTime | UTC; approvedAt < expiresAt <= approvedAt + 24h |
| revoked | revoked | boolean (Yes/No) | must be literal false when active; never treat null as false |
| status | status | text (single line) | literal 承認 only after independent human approval |
| executionId | executionId | text (single line) | empty before reservation; service-managed |
| executionStatus | executionStatus | text (single line) | empty before reservation; service-managed |
| executionResult | executionResult | text (multiple lines, plain) | service-managed JSON, avoid sensitive data |
| backup | backup | text (multiple lines, plain) | service-managed JSON, code caps at 60,000 UTF-8 bytes; Graph/SharePoint field limits must be separately proven |

Do not create a default-approved item. New items must remain unapproved; `revoked=false` alone never authorizes execution. The 15 internal names must be unique and match `FIELDS` in `src/scopedApprovalExecution.js`.

Configuration after **separate** live authorization and verified Graph metadata:
- `SHAREPOINT_APPROVAL_SITE_ID`: exact Graph site ID.
- `SHAREPOINT_APPROVAL_LIST_ID`: exact list GUID.
- `SHAREPOINT_APPROVAL_FIELD_MAP`: JSON map of each of the 15 logical keys to verified internal names.
- `SHAREPOINT_APPROVAL_ALLOWED_APPROVER_IDS`: verified human Entra IDs only.
- `SHAREPOINT_APPROVAL_TARGETS`: explicit allowlisted target mappings.
No real IDs, human IDs, credentials, or Azure settings are changed by this design.

## Security boundary / permission separation

Target: human approvers can make an approval decision but cannot edit executionId/executionStatus/executionResult/backup; execution service can reserve/write execution fields but cannot change human decision, identity, scope or timestamps; ordinary users cannot approve or reserve. **SharePoint list-level edit permission alone cannot enforce these per-column restrictions.** A separately authorized approval write broker/flow and an execution-only broker or equivalent enforceable access boundary is mandatory. Do not enable the current Store if approvers and service can arbitrarily edit the same item fields. Independently audit item creation, identity attribution and permission inheritance; fail closed if not provable.

`verifyHuman` currently requires Graph `lastModifiedBy.user.id === approverId`, no application actor, allowedApproverIds membership, and `GET /users/{id}?$select=id,accountEnabled` returning enabled. This must be demonstrated with existing directory permissions; a service-written approval decision cannot masquerade as a human edit. Atomic reservation preserves original human snapshot because reservation itself changes lastModifiedBy to the service identity.

## Draft-only regression acceptance

1. Missing/misnamed/duplicate columns, wrong types, empty approver allowlist: BLOCKED.
2. `approvedAt`/`expiresAt` Graph UTC roundtrip and timezone offsets, invalid date, future approval, expired or >24h: BLOCKED.
3. `revoked` null/string true/false or true: BLOCKED; literal false with status 承認 required.
4. Application actor, actor mismatch, disabled Entra account, Graph 403/404, approver not allowlisted: BLOCKED.
5. Graph item ETag missing, stale ETag/412, concurrent reservation, replay or lost reservation: BLOCKED, no retry.
6. Execution reservation re-read, immutable scope/hash, original human snapshot, final recheck and single-use receipt: required.
7. Backup 60,000 UTF-8 bytes boundary; >60,000 rejected. Verify actual multi-line SharePoint capacity and Graph write behavior before any live use.
8. Verify all update/save/publish server routes fail closed unless trusted approvalStore, readCurrentSha, target verification, backup and postcondition are injected; preserve separate approvals for each operation.
9. CI: npm test, validate:openapi, test:mcp-tools, test:safety on the exact Draft HEAD; retain push-run checkout SHA evidence.

## Known contract mismatch to resolve before wiring PR #137

`approvalLedger.js` uses `targetSha/appId/changeHash/approvalStage/approver`, while `atomicApprovalReservation.js` uses `commitSha/targetId/diffHash/tool/approverId`. No implicit aliasing. PR #125's `commitSha` binds **running Bridge code**; PR #137 must explicitly specify the SHA domain and recompute canonical diffHash consistently. `src/server.js` currently constructs an unconfigured mutation gate and intentionally BLOCKS update/save/publish. Never bypass that guard to make tests green.

Design acceptance is not live readiness. Requires separate authorization for SharePoint creation, permissions, Azure configuration, merge, deployment, and Power Apps save/publication.
