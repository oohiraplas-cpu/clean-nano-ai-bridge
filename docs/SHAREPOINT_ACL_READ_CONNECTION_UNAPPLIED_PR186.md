# SharePoint ACL READ adapter — UNAPPLIED production connection plan

Target site: https://hisyoengineer.sharepoint.com/sites/cleannano
Target list GUID: 973f17d6-3566-4795-9712-2386bb7bf540
Status: DESIGN / MOCK ONLY. Never enables WRITE. Do not install a new Premium HTTP action, custom connector or paid service.

## REST contract
Use the SharePoint REST endpoint under the fixed site origin (not Graph):
1. GET `/_api/web/lists(guid'973f17d6-3566-4795-9712-2386bb7bf540')?$select=Id,HasUniqueRoleAssignments,EffectiveBasePermissions`
2. GET `/_api/web/lists(guid'973f17d6-3566-4795-9712-2386bb7bf540')/roleassignments?$expand=Member,RoleDefinitionBindings` (follow every trusted same-origin pagination link, fail closed on truncation).
3. GET `/_api/web/lists(guid'973f17d6-3566-4795-9712-2386bb7bf540')/getusereffectivepermissions(@u)?@u='<encoded SharePoint claims login>'` for each known human login; validate returned High/Low permission bitmask before deciding EditListItems. Verify query encoding against real API without writes.
4. Check list items' HasUniqueRoleAssignments where applicable; list-level rights alone do not prove item-level denial.

## Authentication
The existing `platformManage.createGraph` uses `https://graph.microsoft.com/.default` app-only tokens. Those tokens MUST NOT be reused against `https://hisyoengineer.sharepoint.com/_api`: the audience differs. Use only an already authorized SharePoint-audience token, acquired through an existing compliant credential route and consent, without disclosing tokens or adding billable connectors. If unavailable, BLOCKED.
Identify the exact effective principal (human, managed identity, Copilot Studio connection, flow owner/run-only, app-only) and prove its token audience and permission scope without printing secrets. SharePoint getusereffectivepermissions for user claims does not independently prove application-only permissions; app-only effective rights need separate verified evidence.

## Implementation changes required before any live READ
- Provide an authenticated **GET-only**, same-origin, fixed-site transport, with strict URL/path allowlist and response size/time limits; never accept arbitrary URLs from caller.
- Validate response Id equals target GUID and response shapes. Follow paging, reject partial results, empty principals, unexpected permissions format, and 401/403/404. Normalize SharePoint verbose/minimal OData responses.
- Map SharePoint login names to independently verified Entra principals. Expand SharePoint/Entra groups and nested membership, handle item-level ACL and deny-by-default on missing evidence.
- Decode High/Low permission masks with a tested bit position for EditListItems; do not mistake generic `readOnly:false` column metadata for effective edit rights.
- Verify non-edit rights for employee, Bridge/Azure managed identity, Copilot Studio connection, Power Automate identities. Confirm approvers' records are independently protected from requesters.
- Keep ACL evidence separated from the production WRITE gate. All decisions remain BLOCKED until audited human approval and E2E.

## Mock test matrix
Positive: correct fixed-list GET sequence, inheritance, role assignments, effective permissions.
Negative: missing transport, target mismatch, invalid principal, missing inheritance, role assignments or permissions, unexpected list GUID, cross-origin/pagination, HTTP 403, malformed claims, duplicate or incomplete group data, service principal not resolved.
Regression: `sharepoint_manage.item_update`, `powerapps_manage.screen_edit`, `powerautomate_manage.edit` return approval_required; `powerplatform_validate` remains READ-only.
