# Bridge source editing / CNAI save-publication handoff

Starting HEAD: 05e82b50a48d5adaa63bb1428d5d80efd5ce2dd1. Draft-only.

## Read-only observations

- Bridge health_check returned status=ok.
- get_powerapps_state resolved CN_AI依頼台帳, app
  f42a9b03-59b9-49d3-a33b-0a210cd3d51e, environment
  4d0aab59-43ec-ecf1-a9d1-869f2517adbb.
- Bridge reported deploymentSha/baseSha 540ed3365beceff082ee729f6246dae723262c47.
  This is Bridge self-report, not independent Azure deployment evidence.
- Source read returned main / powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml,
  blob f5fa216f178372d937c540d20654a221595d6ef2, stateContextComplete=true.
  This confirms repository source/session retrieval, not actual canvas equivalence.
- The response's sourceControl configuration says GitHub/main/active. Native
  Solution Git integration has not been independently verified.

## Correction to lifecycle audit

PowerAppsStore.saveApp alone only reads state, but server.js's save route first
calls refreshFromGit then pullFromGit. The update-source route also calls both
through applySourceFileChange. Existing Dataverse action calls are
RefreshChangesFromGit and PullChangesFromGit. The publish route calls the actual
management publish endpoint. Therefore the complete code path is not absent.
Its live compatibility, approval unification, source application and readback
remain unverified. CNAI pointing at these tools does not establish a separate
working save/publication implementation.

## Draft implementation

The existing update_powerapps_app tool accepts an optional boolean deferSync.
With true, only the existing guarded Git source update runs. It performs NO
Dataverse authentication, refresh, pull, canvas save or publish. The public MCP
schema and HTTP validator carry this option; metadata-only updates cannot use it.
Existing branch and state checks are retained. No Draft branch is made canonical
and no production call was made during this work.

The source response must contain a full commit SHA and a Git blob SHA matching
the actual UTF-8 content; otherwise return blocked and prohibit automatic retry
because the Git write may already have happened. A successful preparation returns
handoff_prepared, saved=false, published=false, immutable source identifiers and
SHA-256, the configured app/environment, recipient=CNAI, mandatory readback and
human approval, readyForSave=false and readyForPublish=false. This is a receipt
for review, not an approval token or an automatic message to CNAI.

CNAI must independently read the exact commit/blob and current target, verify
backup and App Checker, obtain operation-bound human approval, call the existing
save path, confirm actual saved source, then separately approve/publicize and
verify the published version. No receiver execution is enabled by this change.

Omitting deferSync retains the existing automatic-sync path. If native Solution
Git integration is missing, the response now says blocked/application_sync_incomplete
while retaining the completed Git update receipt; it no longer claims global ok.
Legacy paths and P0 approval integration gaps remain as recorded in the earlier
audit. This patch does not certify or enable Bridge-wide approved operations.

## Validation

Focused store/validation/safety tests: 12 PASS. HTTP + JSON-RPC handoff test: PASS;
it asserts zero Power Platform calls and configured target binding.
Full npm suite and exact-new-HEAD CI are recorded in PR #137 after completion.

## Remaining blockers

This option exists only in the Draft code. Deployment and connector schema
resynchronization have not occurred and remain prohibited in this task. No live
source edit, save, publication or CNAI delivery was executed. Native Solution
integration and receipt-consuming CNAI instructions/tools still need verification.
