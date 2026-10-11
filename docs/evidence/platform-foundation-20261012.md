# Integrated execution foundation — partial implementation, BLOCKED

Base inspected: `877886cca46e4c518cb53c912f2fc25e76311566`.
Scope: review branch, local tests, PR and CI only. No merge, production deployment,
Power Platform mutation, new connection, permission change or paid activation.

## Verified observations

- Connected Bridge `health_check`: `{ "status": "ok" }`.
- This session exposes 14 Bridge connector tools. `get_powerapps_source` accepts
  only `relativePath`; source validation/comparison and `tools/list` are not
  callable through that connected schema.
- Repository registry: 81 public tools. Both source validation/comparison and
  session fields already exist in code. OpenAPI had only 32 names; synchronized
  to 81. Server GET and JSON-RPC discovery agree in local tests. Production
  `tools/list` was not independently obtained; no production-registry claim.
- `get_sharepoint_list(listName="CN_Approvals", top=1)` returned list-not-found
  in the Bridge default site. This does not establish absence in every site.
- Existing PR #123 HEAD `62cf211bd32467038d71fdc30823b4ff00657827`: Actions
  run `38141664464` (#666) completed successfully. PR #122 is an alternative
  approval fetchRows implementation. Neither was merged or copied by this PR.
- No local PAC or Azure CLI executable is available. Runtime identity,
  SOURCE_MAP and a safe isolated Power Platform environment remain unverified.

## Changes

1. Generate OpenAPI method enum and exact connector schema snapshot from the
   server registry. Test equality with both discovery transports and session fields.
2. Replace 26 non-operational adapter methods that fabricated success with
   structured HTTP-503/not_configured errors. Tokens supplied by a caller do
   not turn these placeholders into working operations.
3. Quarantine unified `execute_powerplatform_request` before the legacy
   orchestrator can mutate anything: the orchestrator accepts caller approval
   flags and lacks the requested scoped ledger gate. Return BLOCKED with an
   audit entry and `externalApiCalled:false`; no client override exists.
4. Keep independent existing tools unchanged. This is NOT a claim that their
   legacy approval gates satisfy the new specification.

## Service inventory

| Service | Existing source capability | Remaining gap / live evidence |
|---|---|---|
| Power Apps | Get/state/source, update/save/publish, source validation/comparison | No live create/edit/save/publish test; runtime adapter auth/map unverified; creation absent |
| Power Automate | Registered HTTP-trigger flow execution and discovery | Flow lifecycle management not implemented; no isolated execution test |
| SharePoint | List/items/columns reads; list/item/column writers | Sites lifecycle absent; approval list identity/field map unresolved; scoped gate not connected |
| Dataverse | Some supporting Power Apps/permissions integration | General table/data/solution execution adapters absent; no live test |
| Copilot Studio | Documentation and orchestration placeholders | Agent/topic/tool lifecycle adapter not connected; no live publish |
| Solutions | Existing manual Power Apps solution workflow | No unified approval-bound solution executor or isolated deploy test |

Complete exact tool names and parameter schemas: `config/mcp-public-tools.json`.
Registration means discoverable, not verified or authorized.

## Required next implementation (not complete)

- Resolve existing approval list site/list/column IDs read-only; select one of
  #122/#123, integrate after review, avoid parallel configuration conventions.
- Add immutable request/target/environment/service/operation/commit-SHA/diff-hash
  binding, verified human identity, explicit expiry/revocation, and durable
  atomic reservation/consumption. Current ledger checks only request/step/tool,
  status, a nonempty approver string, timestamp and revocation. It is insufficient.
- Store approval use and audit evidence durably. ExecutionQueue is in-memory and
  advances bookkeeping without calling tools; do not interpret it as execution.
- Reuse existing actual API clients behind the new gate. Independently authorize
  creation, overwrite, connection/permission/secret changes and rollback. New
  creation must bind purpose, cost review and duplicate check evidence.
- Add missing documented service adapters only after real target/auth/isolated
  environment inventory. Reject unconfigured operations; never substitute mocks
  for live evidence or use production as a test environment.
- Existing main push triggers Azure deployment. Separate deployment approval
  from merge, with reviewed deployment-SHA/environment binding and enforced
  human review. Workflow/environment settings were not changed in this PR.
- Verify refresh in the existing Copilot connector after approved deployment.
- Finish bounded error classification/repair/retest, approved rollback and
  post-deployment observation before reporting READY_FOR_REVIEW for the full goal.

## Validation

Final local full suite: 1407 PASS / 0 FAIL.
Targeted final adapter/handler regression: 54 PASS / 0 FAIL.
OpenAPI: 1 PASS; MCP suite: 150 PASS; all failures: 0.
PR CI must be checked against the committed final HEAD.
All operation tests here use local fixtures. Actual Power Platform creation,
editing, saving, publishing, approval consumption and rollback: NOT TESTED.

Overall goal status: **BLOCKED**. This reviewable foundation does not satisfy
all-service approved execution. Live target and approval infrastructure are
unverified; additional adapter and gate implementation remains necessary.


## Follow-up implementation: scoped SharePoint edit executor

The same review branch now implements an opt-in structured approvedOperation on
execute_powerplatform_request. It supports existing SharePoint item updates only:
verified Graph human identity, allowlisted target/fields, environment and running
Bridge SHA binding, canonical payload hash, expiry/revocation, ETag reservation,
backup before mutation, conditional target PATCH, readback and durable outcome.
Reserved approvals cannot be replayed across executor instances or concurrent
workers. Caller flags/tokens are not authorization.

Local final full suite: **1436 PASS / 0 FAIL**. New scoped tests: **29 PASS**,
including JSON-RPC and legacy HTTP paths against simulated Graph. OpenAPI: 1 PASS.
Final safety suite: 65 PASS. Real SharePoint mutation and deployment: NOT RUN.
The exact runtime configuration and current boundaries are documented in
`docs/scoped-approval-execution.md`. Legacy individual mutation tools are not all
migrated; other service adapters remain incomplete. Overall live-use status
remains BLOCKED until real approval list metadata/access, approvers and a safe
validation target are supplied and verified, and independent deployment gates pass.
