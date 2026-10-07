# CLAUDE.md

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


## 3AI共通Bridge実行規則（2026-10-07）

ChatGPT・Claude・Copilotは、過去ログや各AIの記憶を実環境の正本として使用しない。作業開始時にBridgeから最新状態を取得し、その実測値を共通状態として使用する。

Power Apps作業は health_check → resolve_app_target → get_powerapps_app → get_powerapps_state → get_powerapps_source の順で開始する。get_powerapps_source が返す provider・repository・branch・canonicalBranch・sourceState・writable を確認する。

正本は GitHub oohiraplas-cpu/clean-nano-ai-bridge の main、root は powerapps/CN_AI依頼台帳/Source。powerAppsAuthority は github_only。Azure DevOpsをPower Apps正本として扱わない。旧branch・fallback branchは参照用途のみとし、書込みは禁止する。

書込み条件は provider=GitHub、repository=clean-nano-ai-bridge、branch=main、canonicalBranch=main、isCanonicalBranch=true、sourceState=github_canonical、writable=true が実取得で確認できること。不一致・未確認・hold・writable=false の場合は Fail-Closed で update/save/publish を停止する。

役割は、ChatGPT=全体判断・仕様・ボトルネック判定、Claude=コード解析・GitHub修正・テスト、Copilot=Microsoft 365/Power Platform側の調査・操作とする。ただし、いずれもBridgeの実測値と承認ゲートを迂回しない。

既存アプリ・既存Solution・既存ソースを優先し、削除・改名・破壊的変更・新規アプリ作成を行わない。本番公開、権限変更、課金・契約、秘密値変更、不可逆操作は対象操作への人間の明示承認を必要とする。同一対象への既承認は再確認しない。

変更後はsourceを再取得して差分を確認し、save後はstate/source、publish後はhealth/state/source/機能反映/Git正本状態を再取得する。実応答を確認するまで完了・保存済み・公開済みと報告しない。


## 3AI最終効率運用規則（2026-10-07固定）

最終運用目標は「1指示・1結果・例外時のみ1承認」とする。

- ChatGPT: 司令塔。目的解釈、仕様確定、影響範囲判断、最終判定を担当する。
- Claude: コード、GitHub、静的解析、テスト、修復を担当する。
- Copilot: Microsoft 365 / Power Platform 実環境の実行・確認を担当する。
- Bridge: 唯一の実環境情報源・実行ゲート・安全ゲートとして扱う。
- ユーザーにAI、接続先、branch、内部経路を選ばせない。既存の安全な経路で自動ルーティングする。
- 1指示を、対象特定→最新状態取得→影響範囲算出→変更前保全→最小差分修正→並列可能な検証→安全な自己修復→再検証→保存→実環境反映→再取得照合→証跡保存、の1実行単位として処理する。
- 同一情報を3AIが個別に再調査しない。Bridgeから取得した最新の実環境状態を共通基準とする。
- 固定値・過去ログ・記憶を実環境の正本として扱わず、可能な値はレジストリまたは実環境から動的取得する。
- 既存アプリ、Solution、正本ソースを削除・改名しない。fallback/旧branchへの書込みは禁止する。
- 通常の読取、診断、バックアップ、テスト、安全な既存ソース修正は可能な範囲で自動継続する。
- 本番公開、権限変更、課金、秘密値変更、不可逆操作は人間の明示承認ゲートを維持する。
- エラー時は認証、接続先不一致、正本不一致、テスト陳腐化、同期、権限、上流API障害等へ分類し、安全な既知修復を優先する。同じ失敗を無意味に反復しない。
- GitHub更新だけでPower Apps実反映完了とは報告しない。保存・反映後は実環境を再取得して一致を確認する。
- ユーザーへの通常結果は「完了」「承認待ち」「異常停止」を基本とし、内部工程の説明は必要時のみ提示する。
