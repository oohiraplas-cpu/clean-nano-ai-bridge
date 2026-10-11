# Approval-bound Bridge execution (initial adapter)

This branch adds a real **code path**, not proof of a live connection. No production
settings, SharePoint records or permissions were changed. Scope currently enabled
by code: **existing SharePoint item edits**. Power Apps save/publish, flow execution,
Dataverse, Solutions and Copilot Studio are NOT enabled through this executor.
The text-only legacy orchestration stays blocked.

## Server configuration, after live metadata verification and separate approval

Reuse #123's configuration convention; it is not merged as a prerequisite:

- `SHAREPOINT_APPROVAL_SITE_ID`: canonical Graph site ID of existing approval list.
- `SHAREPOINT_APPROVAL_LIST_ID`: existing list GUID.
- `SHAREPOINT_APPROVAL_FIELD_MAP`: JSON mapping for all keys below to verified,
  distinct internal column names. No defaults are guessed.
- `SHAREPOINT_APPROVAL_ALLOWED_APPROVER_IDS`: comma-separated verified human Entra
  IDs. Never place an AI/service principal or shared automation account here.
- `SHAREPOINT_APPROVAL_TARGETS`: explicit registered targets, keyed by a stable
  targetKey. Each contains siteId, listId, environmentId, allowedFields. Use only
  canonical Graph site IDs/list GUIDs, not alternate aliases for the same list.
- `DEPLOYMENT_SHA`: verified running Bridge commit, not a caller-provided value.

Required ledger keys: requestId, tool, targetId, environmentId, commitSha, diffHash,
approverId, approvedAt, expiresAt, revoked, status, executionId, executionStatus,
executionResult, backup. Logical keys are not a mandate to create columns: first
inspect existing schema and map it. Creating columns/lists is not automatic.

Human approval requires `status=承認`, explicit boolean `revoked=false`, a validity
window of at most 24 hours, and initially empty executionId/executionStatus.
The last modifying identity returned by Graph must be the same approved human ID,
with no application identity. `/users/{id}` must confirm an enabled account.
This intentionally rejects approvals edited by workflows or unverified identities.
Actual Graph identity semantics and existing directory-read permissions must be
verified; this code does not grant permissions or weaken the check on failure.
Approval list write access must be restricted to trusted approvers and execution
account; do not activate this against an ordinary user-editable list.

## Request

Call existing `execute_powerplatform_request` with `request` and `approvedOperation`:

```json
{
  "request": "Apply this approved existing-item edit",
  "approvedOperation": {
    "approvalId": "<existing approval item ID>",
    "requestId": "<approved request ID>",
    "tool": "update_sharepoint_list_item",
    "targetId": "<canonical site ID>/<list GUID>/<item ID>",
    "environmentId": "<registered environment ID>",
    "commitSha": "<verified running Bridge SHA>",
    "diffHash": "<changeHash of this operation>",
    "params": {
      "targetKey": "<registered target key>",
      "itemId": "<existing item ID>",
      "expectedETag": "<ETag observed during change preparation>",
      "fields": { "<allowed internal field name>": "<approved value>" }
    }
  }
}
```

`changeHash` in `src/scopedApprovalExecution.js` hashes canonical JSON containing
requestId/tool/targetId/environmentId/commitSha/params, with sorted object keys.
This binds the complete edit and expected target version, not just its label.
commitSha binds the running Bridge code; it is **not** a Power Apps source blob SHA.
Approval must record that hash and exact scope through a human workflow; the AI
executor never writes approval decision, identity, scope, or timestamps.

## Actual execution sequence

1. Validate registered target and allowed scalar fields. Approval-list editing is
   prohibited in this route. No creation/deletion, arbitrary URL or generic tool call.
2. Read the exact approval item and Graph identity. Match every scope field,
   payload hash, running SHA, expiry, revocation, and unused state.
3. Read the existing target and require the expected ETag. Capture its fields;
   refuse a backup exceeding 60 KB.
4. Atomically reserve the approval using `If-Match` on its ETag. Persist execution
   ID, backup and start evidence **before** editing the target.
5. Re-read reserved approval; reject changed scope, revocation or reservation loss.
6. PATCH only approved target fields with the target's `If-Match` ETag.
7. Re-read and compare each requested field; record the outcome in the approval
   record, again using an ETag. Never write the raw upstream result to the audit.

Microsoft Graph documents PATCH /sites/{site-id}/lists/{list-id}/items/{item-id}/fields
and If-Match/412 behavior:
https://learn.microsoft.com/en-us/graph/api/listitem-update?view=graph-rest-1.0

A reserved approval remains consumed after failure, network uncertainty, process
restart or audit failure. There is no automatic reset, retry or rollback. Diagnose
and obtain a fresh, specific approval for recovery. This prevents duplicate writes
across Bridge replicas. Cancellation after successful reservation is not a reliable
way to stop an already starting operation; use a separately approved recovery.
The backup contains the target's data and requires the approval list's existing
access controls and retention policy. This is a backup for one item, not a whole
site or app backup.

## Boundary and remaining work

Existing legacy individual write tools have NOT all been migrated to this gate.
Do not claim Bridge-wide single-use approval enforcement or complete service
coverage. Do not deploy as a complete unified platform until those paths are gated,
required safety reviews pass and live tests succeed. The initial adapter provides
an end-to-end, testable migration pattern.

Default-site `CN_Approvals` lookup previously failed. PR #123 also reports list
metadata unresolved for the canonical site; don't repeat guessed-name searches.
Need existing approval list URL/GUID and actual columns, permitted human IDs,
verified non-production target, existing access capabilities and independent
merge/deploy approval before live use. No new list/connection/license is assumed.
