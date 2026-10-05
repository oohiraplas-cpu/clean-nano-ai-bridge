# CNAI Executive vNext — existing Bridge enhanced features

## Implemented scope

The single existing CNAI（M365版） (コピー) entry in clean nano remains the entry point. The existing MCP action `clean nano AI Bridge｜業務統合・Power Apps自動改修` holds the Executive description. No duplicate agent, application, screen, list, flow, connection, or permission is created.

`config/executive-policy.json` contains the decision priorities, fourteen advisory roles, management and loan checklists, reuse rules, approval rules, source safety, response rules and human final decisions. `get_executive_policy` exposes that versioned policy and keyword routing candidates; it does not create fourteen autonomous agents or execute their decisions.

`get_executive_brief` reads explicitly identified existing SharePoint lists and actual columns, distinguishes original values from calculated values, and lists missing data and possible sources. It never forecasts unknown values, writes records, or totals an incomplete sample. Up to eight sources and 200 items per source are supported. Period, units, currency, document reconciliation, and whole-company totals remain unverified. Empty/unconfigured sources return missing data rather than synthetic finances. Financial list/column mappings must be confirmed before requesting readings. No new access or consent is required by this implementation; the existing Reader is reused.

The existing SharePoint schema adapter now accepts the actual Reader `{ columns }` response. The existing flow-list tool uses the actual configured flow registry and does not claim an unsupported adapter returned zero flows. Its scope is only Bridge-registered flows, not the entire tenant. URLs and SAS values are excluded.

## Source mismatch and hold

On 2026-10-05 the live Power Apps solution `CN_AIIraiDaicho` showed Azure DevOps organization `cleannano`, project/repository `clean-nano-powerplatform`, branch `main`, folder `powerapps/CN_AI依頼台帳/Source`. This is a dated portal observation, not runtime verification.

The Bridge currently has a GitHub source adapter for `oohiraplas-cpu/clean-nano-ai-bridge`. Its review fallback branch is not established as current live source. The application rule now records this mismatch as HOLD. Resolution no longer declares parity from a GitHub directory alone in the observed environment. Source responses show the hold and writeability. Editing, saving, and publishing this target are rejected before side effects, including metadata edits. No branch, file, or live Power Apps asset is deleted or promoted from the old export.

Native Azure DevOps source retrieval/synchronization and runtime verification remain unimplemented. Do not release the hold merely because both branches are named `main`. A current matching native export, repository adapter and end-to-end tests are required first. The solution export portal reported success/downloaded, but no local file path was obtained; that attempt is not counted as a saved recovery artifact.

## Copilot reflection and verification

The instruction baseline and Executive draft are preserved in adjacent files. The draft contains 7,120 characters, within the 8,000-character limit. The action description contains 559 characters. New tools must be visible in the live `tools/list` and refreshed Copilot action before use. The existing MCP inventory of 42 tools becomes 44, preserving the first 42 tools and the original first 18 ordering. Existing duplicate MCP action remains disabled.

Local verification: 201 tests pass, covering unit, HTTP MCP authentication/dispatch, invalid inputs, missing columns/config, upstream failures, no fabricated totals, secret redaction, native repository hold, existing APIs, OpenAPI and regression tests. GitHub CI and live deployment/publication results must be recorded separately; local tests do not establish live completion.

## Authorization and rollback

The user explicitly instructed this same Bridge and CNAI copy to proceed through production publication earlier in the current session, and the Executive instructions say not to request the same authorized action again. This release continues that authorization for this Bridge/CNAI target only. It does not authorize new permissions, charges, deletions, credential changes, external sends, or human final submissions.

Previous production baseline: `d89ed21ae948106284d764723dc7855caeef2242`. Roll back by deploying that verified version through the existing Azure workflow after checking target and authorization, then run health and actual tool tests. Prefer a revert commit over force-push. Restore `docs/copilot-instructions-before-executive-20261005.txt` into the existing agent, clear only the added action description (previously empty), save, publish under applicable authorization, and test. Preserve audit evidence and all existing assets. Application data and native Git connection settings were not changed by this release.

## Remaining work

1. Confirm the existing financial lists, column mappings, units and accounting periods; add explicit bindings without creating duplicate lists.
2. Implement and verify native Azure DevOps source operations before removing the Power Apps hold.
3. Validate business calculations against original accounting documents and specialist review before enabling decision automation.
