# CLAUDE.md

## Inspection safety tools

Keep the first 28 MCP tool definitions, names, order and contracts unchanged. Append only
`inspect_powerapps_structure`, `analyze_change_impact`, `create_change_snapshot` (31 total).
Schemas and strict runtime validation live in `powerAppsInspectionValidation.js`; services
are `powerAppsStructureService.js`, `powerAppsImpactService.js`, `changeSnapshotService.js`.
Both JSON-RPC and legacy dispatch use these services. Do not fall back across branches:
load the complete canonical root from one immutable Git commit and verify every blob.
Never echo source, tokens, upstream error bodies, or YAML parser snippets. Never call write,
deployment, Power Apps, SharePoint, or permission APIs from inspection.
`confirmed` means directly observed static definitions/references; `possible` means unresolved,
dynamic or external dependencies. Runtime/compiler binding is always unverified. Report
`incomplete`/`blocked` honestly; JSON-RPC sets `isError:true` for these outcomes.
Snapshot creation refuses findings or unresolved dependencies, uses canonical SHA-256 IDs,
atomic no-replace publication and re-verification of existing snapshots; never overwrite
tampered evidence. Snapshots must remain Git-ignored or outside any Git checkout, with no
symlink path components. `POWERAPPS_SNAPSHOT_DIR` defaults to ignored `data/change-snapshots`.

Validation: `npm test`, `npm run validate:openapi`, `npm run check:secrets`,
`npm audit --audit-level=low`, `npm run inspect:local`. Local inspection reads committed
Git source (no remote application mutation) and includes performance measurements.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small Node.js/Express "bridge" API that lets Power Apps, Power Automate, and Copilot Studio (via HTTPS/Custom Connector) exchange task state with external AI services (Claude Code, Copilot) through webhooks and a minimal MCP-style endpoint. It is a task queue/state machine in front of a JSON file, not a SharePoint client — SharePoint Lists is the real system of record; `data/tasks.json` is only a local dev/test cache.

## Commands

```bash
npm install
cp .env.example .env
npm test                        # runs all tests (node's built-in test runner)
npm start                       # start the server (reads .env via dotenv)
npm run validate:openapi        # validate openapi.yaml only
node --test test/server.test.js # run a single test file
```

There is no lint/build step and no test-name filtering script configured — use `node --test <file>` to scope to one file (the built-in runner supports `--test-name-pattern` for filtering within a file if needed).

## Architecture

- `src/config.js` — reads all runtime config from `process.env` via `getConfig(env)`. Nothing else in the app reads `process.env` directly; tests pass config objects in instead of setting env vars.
- `src/sharePointTaskStore.js` — SharePoint Lists-backed alternative to `TaskStore`, same interface (`list/upsert/update/next`). Auth is client-credentials against Microsoft Graph (`SHAREPOINT_*` env vars); list column names are configurable (`fieldMap`) since the production list's actual internal column names aren't known from this repo. Selected via `TASK_STORE_BACKEND=sharepoint` (default remains `file`).
- `src/taskStore.js` — file-backed task persistence (`data/tasks.json` by default). Owns the task status state machine:
  - `resolveStatus(task)` derives the authoritative `status` on every read/write, in priority order: `retry_count >= 3` → `停止` (stopped), else `approval_required === true` → `人間承認待ち` (awaiting human approval), else `userActionRequired === true` → `ユーザー操作待ち` (awaiting user action), else the task's own `status` (default `未着手`, not-started).
  - `normalizeTask` runs this on every read/write, so status is never trusted as input — it's always recomputed.
  - `next()` returns the first task whose status is *not* in `NEXT_EXCLUDED_STATUSES` (`人間承認待ち`, `ユーザー操作待ち`, `停止`, `完了`). No task matching → callers get `タスクなし` (no task).
  - There is no locking/concurrency control — reads/writes are whole-file JSON read-modify-write, fine for the low-volume bridge use case this targets but not safe for concurrent writers.
- `src/validation.js` — hand-rolled request body validators (`validateTaskInput`, `validateStatusInput`, `validateMcpInput`) used before touching the store. All `status` values are validated against the canonical `STATUSES` list exported from `taskStore.js`.
- `src/server.js` — `createApp(config, store)` builds and returns the Express app (both args are optional/injectable, which is how tests spin up isolated instances against temp files). Routes:
  - `GET /health`
  - `GET /api/tasks`, `GET /api/next`
  - `POST /webhooks/claude-code`, `POST /webhooks/copilot` — API-key gated (`WEBHOOK_API_KEY`), upsert a task, tag it with `source` derived from the path
  - `POST /api/tasks/:id/status` — patches a task's status-relevant fields (not API-key gated)
  - `POST /mcp` — API-key gated (`MCP_API_KEY`), the common MCP-style entry point for ChatGPT / Claude Code / CN_総合秘書AI. Dispatches the methods listed in `MCP_METHODS` (28 tools, all of which must also appear in `MCP_PUBLIC_TOOLS`; a test enforces this). The three standard methods (`health_check`, `get_tasks`, `get_next_task`) to the same logic behind `GET /health`, `GET /api/tasks`, `GET /api/next`, returning `{accepted, method, result}`. Any other `method` value is a `400`.
  - API key checks use `crypto.timingSafeEqual` after a length check (see `apiKeyMiddleware`); an empty configured key disables auth for that route entirely
  - Central error handler returns Japanese error messages and never leaks internals (`内部エラーが発生しました`)
- `src/errors.js` / `src/secretMasking.js` — Bridge共通のエラー生成（`bridgeError`・未構成用`notConfiguredError`・上流応答用`upstreamResponseError`）と、診断ログ向けの秘密値マスク。`error.payload`はtools/callのstructuredContentとlegacy応答にそのまま追加される。
- `src/powerAppsChangeValidation.js` / `src/powerAppsStaticTests.js` — `validate_powerapps_change`・`verify_save_result`・`run_powerapps_tests`の本体（外部APIには直接触れず、取得処理は注入）。検証材料が無い項目は成功扱いにせず`skipped`＋`reason`で返す。
- `src/deploymentService.js` / `src/permissionsService.js` — デプロイ連携（GitHub Actions workflow_dispatch）と権限管理のService。設定は`config.deployment` / `config.permissions`（`DEPLOY_*` / `PERMISSIONS_*`）。未構成は`503`＋`status:not_configured`・`reason`・`missingConfiguration`で拒否し、ダミー成功にしない。本番へのデプロイ（`deploy_to_test`）は常に拒否、本番ロールバックと`update_permissions`は`approvedByHuman:true`必須。
- `src/powerAppsGitStore.js` — 更新は正本branch（`POWERAPPS_GITHUB_BRANCH`）にあるファイルに対してのみ行う。フォールバックbranchでしか見つからないソースへの更新は409で拒否する（`canonicalBranch` / `assertCanonicalBranch`）。
- `openapi.yaml` — the OpenAPI 3.x contract for the Power Platform Custom Connector. Every operation must have an `operationId` (enforced by `test/openapi.test.js` via `@apidevtools/swagger-parser`). `servers` is intentionally left unset until a public host is chosen. Keep this in sync with `src/server.js` and `src/validation.js` when changing routes/schemas.

## Conventions

- User-facing status values and API error messages are in Japanese (e.g. `未着手`, `実行中`, `完了`, `停止`, `エラー`, `判断待ち`, `人間承認待ち`, `ユーザー操作待ち`, `タスクなし`). Match this when adding routes or statuses — don't introduce English status strings.
- Never let AI-driven automation fully complete an approval step: `approval_required=true` must always resolve to `人間承認待ち` and requires a human to actually change it.
- Config only ever comes through `getConfig`/injected config objects, never `process.env` reads scattered through the app.
- Secrets (`WEBHOOK_API_KEY`, `MCP_API_KEY`, external AI API keys) belong in deployment environment variables only — never in code, `.env` committed to git, or `data/tasks.json`.
- `HOST` defaults to `0.0.0.0` (cloud-container friendly); `PORT` should come from the deployment environment.
- CORS is allow-listed via `CORS_ORIGINS` (comma-separated), not wide open.
