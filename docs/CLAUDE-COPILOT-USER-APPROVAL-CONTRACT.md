# Claude Code / Microsoft Copilot — User interaction contract

Scope: clean nano connection repair and Company OS automation. Effective for PR #263 and subsequent implementations.

## User-facing rule
The user supplies the goal. Claude Code and Copilot must autonomously inspect, implement, test, verify, audit and prepare recovery using existing authorized connections. Do not ask the user to click Continue, transfer instructions between agents, copy logs, collect screenshots, run commands, or manually operate Azure/GitHub/Power Platform when an authorized tool can perform the action.

**The normal user interaction is a single explicit approval: 「承認する」**, only for a specific, presented, high-impact permission change, external publication, irreversible action, material production risk, or new cost/contract. Approval must be scoped to one action and target, bound to an authenticated identity, expiring and single-use, with durable atomic consumption. The text alone is never a substitute for authentication or proof of approval.

**Authentication exception:** first-time sign-in, MFA, OAuth consent, or provider-enforced interactive authentication may require the user. Consolidate to one minimal instruction when unavoidable. Do not request passwords, API keys or tokens in chat.

## Execution
1. Discover actual capabilities and current state; reuse existing assets and standard connectors, avoid premium fees.
2. Snapshot/dry-run and check permissions, cost, and rollback.
3. Implement on an isolated branch; perform selective tests, full CI and independent readback.
4. For a gated operation, present one concrete approval request (target, exact change, risk, rollback). Wait for 「承認する」; validate identity, scope, expiry and one-time consumption server-side before mutation.
5. Execute only the approved action, verify live behavior, audit, and rollback if verification fails.
6. Report COMPLETE only after production E2E and evidence; otherwise PARTIAL/BLOCKED with exact blocker.

## Agent responsibility
- Claude Code: source implementation, tests, GitHub PR/CI, evidence and rollback artifacts.
- Microsoft Copilot: Power Platform, SharePoint, Entra and Azure inspection/implementation using authorized connections; never assert actions not observed.
- ChatGPT: orchestration, safety gates and independent verification.
- Keep Power Platform Pack, CLI Pack and OZ Router separate; do not merge their products or rename/delete existing assets.

## Current state
PR #263 implements read-only diagnosis and approval interfaces. Provider mutation adapters, durable transactional store wiring, and real Microsoft/Azure E2E are NOT verified. CI success is not production readiness. No automatic publish/merge before independent production gates.
