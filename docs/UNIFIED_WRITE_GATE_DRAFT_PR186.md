# Unified Bridge MAX WRITE Gate — Draft Design (PR #186)

Status: DESIGN ONLY. The four unified tools retain all handlers, but unified WRITE is currently denied at MCP dispatch and platformManage.run. No production deployment, merge or publication.

## Call path
MCP authenticated HTTP request -> tools/call (or legacy method route) -> executeWithState -> executeMcpMethod -> platformManage.run -> HANDLERS.

## Required gate before any WRITE may be enabled
1. Authenticate transport identity; bind immutable credential/MCP-session scope, target tenant and environment. No user-supplied scope bypass.
2. Normalize tool and operation; reject unknown operations; classify READ/WRITE using an audited allowlist (default WRITE).
3. Require StateContextRegistry session issued by get_powerapps_state or an equivalent approved target-specific authority observation. Verify session TTL, credential scope, target app/flow/list, environment, canonical branch, immutable SHA, and observed source; recheck immediately before mutation. For SharePoint/Flow operations, define a distinct verified target observation contract rather than borrowing an unrelated Power Apps session.
4. Require ApprovalLedger.check({requestId,stepIndex,tool}) against configured SharePoint approval records. Do not accept approvedByHuman=true, a DELETE confirmation string, or tool arguments as substitutes. Bind approval to the exact operation, target, parameters digest, actor, and snapshot/commit SHA. Existing ledger validates request/step/tool and freshness but not all of these; schema and binding require review before enabling WRITE.
5. Run Premium/unknown connector check against the *resolved full target artifact* and requested mutation. Missing metadata or unknown connectors => BLOCKED. Keep the standard connector allowlist explicit and audited.
6. Before mutation require snapshot, no destructive changes, least-privilege authorization, concurrency/ETag, idempotency key, and rollback readiness. Revalidate all gates immediately before execution. Record audit evidence, then verify readback and invalidate stale sessions.
7. Fail closed for missing config, expired/revoked approval, mismatched scope, stale state, unknown connector, partial readback, or unavailable backing service. Human approval is mandatory before deployment/publish.

## Regression matrix (no live writes)
- Missing/expired/revoked/mismatched approval; boolean approvedByHuman spoofing; wrong tool, target or step.
- Missing/expired/scope-mismatched State Manager session; changed SHA, environment, branch or source.
- Unknown WRITE alias; legacy JSON-RPC method and tools/call route; direct platformManage.run entry.
- Premium HTTP/Dataverse/custom/unknown connector; missing connector metadata; standard-only valid fixture.
- Simulated WRITE with fully authorized synthetic ledger and registry; verify exact handler called once and readback; no real Microsoft API calls.
- CI fail means no merge, deployment or publish. Draft PR remains Draft.

## Public tool design (target 28, not yet applied)
- Common authority/diagnostics 6; Power Apps READ 8; SharePoint READ 4; Power Automate READ 4; Repair/Audit READ 6.
- Existing 98 tools remain implemented; filter exported tools only after Copilot Studio's actual registered count and environment-specific limit are observed.
- Never expose unified WRITE while central gate remains incomplete. Verify aliases and nested operations cannot bypass allowlist.

## Known blockers
- ApprovalLedger currently verifies requestId/stepIndex/tool/status/approver/time/revocation but does not bind exact target/parameters digest.
- Existing registry is Power Apps-centric; SharePoint and Power Automate require scoped target observations.
- Copilot Studio CNAI M365 registered tool count and any 70-tool tenant-specific limit have not been independently observed.
- No live WRITE E2E is permitted under this task.
