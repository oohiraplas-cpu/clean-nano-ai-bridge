# Bridge MAX / CNAI recovery — 2026-10-30

Base: `bea8745270ae96501ec52bce455cea42a2879770` (GitHub main and runtime-reported deploymentSha match; independent Azure deployment attestation BLOCKED).

## Verified live, read only

- MAX health_check: ok.
- clean nano kk: app `f42a9b03-59b9-49d3-a33b-0a210cd3d51e`, environment `4d0aab59-43ec-ecf1-a9d1-869f2517adbb`.
- get_powerapps_app and get_powerapps_state return appId/environmentId. The reported acquisition failure is not reproducible on this revision.
- Same state session, get_powerapps_source targetNames S1_Home/S2_Calendar: 2/2 source observations, authorityContextComplete/sourceObservationComplete/stateContextComplete all true. Source file hashes respectively `8bf8509883191c6d0d5392af9b32551c8edef1a8` and `c20027b3228d576c417603b6431e6c396888f1b3`.
- CN_社員台帳 read (top 1): status ok; personal data excluded from this evidence.
- Power Automate flow list: succeeds; CN_日報PDF作成 observed on. Registered HTTP execution route is not configured (POWER_AUTOMATE_FLOWS missing); flow execution not verified.
- MAX reports API key authentication using X-API-Key. No credential read or copied.

## Reproduced failure and repair

run_powerapps_tests published schema allowed only files/knownScreens/knownDataSources, while production State Manager requires stateContext. Calling with published arguments fails closed, and supplying context was rejected by its parameter validator.

The repair permits stateContext/stateSessionId in the schema and parameter validator, sets file count schema bounds, and checks the registered source session, transport scope, context and TTL before static analysis whenever enforcement is enabled or context is supplied. Existing clients without context remain supported only when enforcement is disabled. Write and approval gates are unchanged.

Regression covers successful acquisition -> source -> static analysis, missing context, forged session, wrong app/environment, commit SHA mismatch, different transport session and expiration. Static analysis continues to report incomplete when runtime tests are skipped.

## BLOCKED / release requirements

- Azure get_azure_deployment_metadata: azure_metadata_unavailable / target_lookup cli_missing. Runtime self-reported SHA matches GitHub but is not independent attestation.
- Existing CNAI M365 tool/connection inventory and CNAI-originated call: no callable connector/browser capability to inspect or edit the existing Copilot agent. src/platformOrchestrator.js explicitly returns Copilot Studio DISABLED / 実装予定. Do not report integration complete.
- Existing documented MCP URL: https://clean-nano-ai-bridge-c7evcxhtergad9b0.westus3-01.azurewebsites.net/mcp . Recheck against the existing CNAI connection before any registration; reuse it and refresh its tool schema after approved deployment. Do not add a second connection or any Premium connector.
- Power Apps save/reread, publish/reread and live rollback have not been exercised; this repair changes no app content.
- Billing and license status not independently accessible. This work creates no paid resources or licenses.

## Review and rollback

Dedicated branch/PR only. Production merge, deploy and publish require explicit approval after CI and review. main_clean-nano-ai-bridge.yml deploys on main push: approving merge can trigger production deployment; do not merge without deployment approval.

Rollback code by reverting this PR through another reviewed PR. Base SHA above is a source reference, not a verified Azure rollback artifact. Before production approval, establish the actual previous deployment artifact and restoration procedure, inspect CI, then deploy; refresh the existing CNAI tool schema and repeat live acquisition/static tests, approval rejection checks and read checks. Do not set approvedByHuman from an AI decision.
