# CN_AI依頼台帳: single target contract

This repository's current development target is **only CN_AI依頼台帳**. Do not edit, import, publish, or reconfigure any other Power Apps app.

## Canonical identity

- App ID: `f42a9b03-59b9-49d3-a33b-0a210cd3d51e`
- Environment ID: `4d0aab59-43ec-ecf1-a9d1-869f2517adbb`
- Organization URL: `https://org0bbb24c5.crm7.dynamics.com`
- Unmanaged solution unique name: `CN_AIIraiDaicho`
- Source root: `powerapps/CN_AI依頼台帳/Source`
- Existing Bridge: `clean-nano-ai-bridge`

All five `POWERAPPS_*` target settings must match the canonical manifest in `src/config.js`. Target checks must run before **every** source update, Dataverse Git sync, direct app update, save, or publish. Never default to a different app. Missing configuration fails closed. Keep credentials out of logs and commits.

## Three-AI responsibilities

- ChatGPT: task orchestration, inspection, evidence review and explicit human-approval handoff.
- Claude Code: source development, automated tests and pull requests. No direct production publishing.
- Copilot Studio: Microsoft 365 business agent using the same Bridge task IDs and authorization rules.
- Bridge: common interface for target identity, read/write permissions, task state, operation results and audit trail.

## Release gates

1. Read-only export of the **latest live target solution**, checksum, artifact retention and source parity comparison. GitHub source read alone does not establish live parity.
2. Confirm isolated test environment and test the restore path there. Never use production as test.
3. Run automated regression tests; verify target checks and human approval across all write paths.
4. Review diff, exact target manifest and audit trail; obtain explicit human approval for production changes.
5. Controlled deployment, post-release verification and rollback readiness.

Existing manual workflow for another app is **out of scope** and must not be triggered. No Gmail notification integration is required. Expanding features (registration, ID, attendance, reports, expenses, salary, vehicles, qualifications) must reuse existing data sources and remain inside the single existing target app. This document records architecture; it does not certify live parity, deployment, or three-AI end-to-end connectivity.
