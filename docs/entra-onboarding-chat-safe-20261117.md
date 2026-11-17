# CN Entra onboarding — chat-mode implementation contract (2026-11-17)
Status: PROPOSED / NOT DEPLOYED. Forms is excluded. Do not modify production or issue identities from this document.

## Entry and authority
- Existing Power Apps "clean nano kk" submits a request; reuse CN_入社申請_仮登録台帳 as the workflow/audit ledger, CN_社員台帳 as the employee identity mapping. Confirm actual app ID, site/list IDs, internal columns and ACLs live before changes.
- Manager approval is mandatory per request; verify the authenticated approver's immutable Entra object ID and authorization server-side. A client-supplied approved flag is insufficient.
- Employee and part-time: create internal member only when approved, authorized and licensed. Contractor: invite guest only when approved. No password/passkey is transmitted in LINE or stored in SharePoint. Microsoft identity registration is completed on Microsoft-hosted pages; LINE may convey a non-secret instruction.
- Before any Graph write: independently check tenant, exact target, existing identities by UPN/email and CN_社員台帳 EmployeeID/EntraObjectId, Graph permissions, conditional access, available licensing, and external invitation policy. Do not grant admin roles or assign paid licenses automatically.

## State machine and idempotency
REQUESTED -> VALIDATED -> PENDING_APPROVAL -> APPROVED -> IDENTITY_PENDING -> IDENTITY_CREATED -> LEDGER_LINKED -> ACCESS_VERIFIED -> COMPLETE.
Terminal/exception states: REJECTED, EXPIRED, DUPLICATE, BLOCKED, RECONCILIATION_REQUIRED.
- Use a durable immutable request ID (not FormsResponseId) and enforce atomic uniqueness/serialization; list query alone is insufficient to prevent races. Existing columns have no proven uniqueness.
- Store only necessary fields; sensitive personal data and tokens must not enter logs, approvals, or audit payloads.
- After uncertain Graph response, query by request correlation and immutable identity before retry; never blindly recreate.
- Graph invite/create returns object ID; verify it belongs to correct tenant and expected identity, then patch EntraObjectId to exact ledger item. Re-read and compare. Check Power Apps access as that principal. Never infer permissions from a successful account creation.
- If linking fails after identity creation, retain identity and mark RECONCILIATION_REQUIRED for explicit administrative resolution; never silently delete.

## Security and release gates
G0: live connector capability + scope + target confirmed.
G1: existing entitlement confirmed; cost or external invitation requires explicit human authorization.
G2: backup configuration, snapshots, least privilege, dry-run, safe branch and audit trail.
G3: server-side approval validation, write, readback, negative authorization tests.
G4: E2E member/guest, duplicates, approval denied, retry/timeouts, rollback readiness.
No production release or user creation before gates pass. Keep existing apps, flows, lists, and forms unchanged until independently verified.

## Acceptance tests
1. Unapproved request cannot create or invite.
2. Forged approval / wrong approver / missing scope returns denied without side effects.
3. Duplicate employee ID, UPN, email or object ID cannot issue a second identity.
4. Concurrent identical requests yield at most one identity.
5. Successful approved member creation links exact object ID; guest invitation separately tested.
6. Graph timeout after possible success reconciles without duplicate.
7. Ledger update failure preserves identity, logs redacted reconciliation checkpoint.
8. Readback verifies ledger, identity and actual app access.
9. No secrets, passwords or sensitive PII in logs, LINE, or approval.
10. No Premium/new license charge; otherwise COST_GATE.

## Current evidence and blocks
GitHub docs/new-employee-registration-flow.md describes existing graph_manage user_create, entra_invite_user and ledger update handlers. The current ChatGPT Bridge MAX connector returns UNAUTHORIZED and does not expose the first two handlers. Production Entra/SharePoint/App IDs, Graph grants, user records, and live E2E are not verified in this session. Do not claim completion.
