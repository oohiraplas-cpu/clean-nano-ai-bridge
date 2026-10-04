# clean-nano-ai-bridge

## Power Apps構造・影響・スナップショット（追加3ツール、合計31）

既存28ツールの名前・順序・契約を維持し、末尾へ次のツールを追加します。
JSON-RPC `tools/call` と既存 `{method, params}` の両形式で利用できます。

| ツール | params | 処理 |
| --- | --- | --- |
| `inspect_powerapps_structure` | `branch`（必須） | 正本branchの完全なソースを同一commitに固定して構造・参照を解析 |
| `analyze_change_impact` | `branch`, `changes`（必須） | 全ソースへ変更案を重ね、定義・直接参照の影響と推定影響を分離 |
| `create_change_snapshot` | `branch`（必須）, `changes`（任意）, `recoveryScope:source_files_only`（任意） | 安全検査済みの変更前後ソースをSHA-256でローカル保存 |

`changes` は1〜50件の `{relativePath, content}` または
`{relativePath, delete:true}`。既存ファイルのみ対象とし、未知のプロパティ、
重複対象、パス逸脱、branch不一致、対象不存在、秘密値、参照切れ、解析失敗は拒否します。
ソース上限は100ファイル・合計4MB・1ファイル1MBです。GitHub treeの省略、
symlink、非対応形式、取得失敗、blob検証失敗も安全停止します。
ソース取得に必要な設定は `POWERAPPS_GITHUB_TOKEN/OWNER/REPO/BRANCH/ROOT`。
未設定時は503 `not_configured`。設定値・秘密値は安全な環境変数へ登録してください。

解析はPower Fxコンパイラーの代替ではありません。`confirmed` はソース上で直接確認した
定義・参照、`possible` は動的遷移・外部/レコード参照・状態/データ依存です。
未検証の実行時動作があるため解析結果は `incomplete`、確定した不備は `blocked`。
JSON-RPCではどちらも `isError:true`、legacyは `result.status` と `issues/limitations`
を確認してください。完全成功・保存許可・本番安全性を意味しません。
ソース本文・式本文・上流エラー本文は応答へ含めません。

スナップショットは `source_files_only` に限定します。復旧に必要なソース定義の欠落、解析漏れ、不備は422で停止します。外部接続・列・実行時状態は証拠と除外理由を記録し、元ソースのバイト列復元に不要な場合だけ保存を許可します。アプリ全体の復旧は未検証です。
保存先 `POWERAPPS_SNAPSHOT_DIR` の既定はGit管理対象外の `data/change-snapshots/`。
Git管理対象・未ignore・symlink経由の保存を拒否し、directory 0700 / file 0600、
canonical JSONのSHA-256、原子的な上書き禁止の保存、同一入力で同一ID、
既存ファイルの整合性再検査を行います。改ざん時は停止して既存ファイルを保持します。
保存結果 `saved` はローカル保存だけを意味し、`runtimeVerified:false`。
外部書き込み・Power Apps変更・SharePoint変更・デプロイ・権限変更は行いません。

```bash
npm ci
npm test
npm run validate:openapi
npm run check:secrets
npm audit --audit-level=low
npm run inspect:local
npm run validate:snapshot
```

実ソースはコミットから再測定します（ソースの編集や外部API呼び出しなし）。
Base `8b76bac42f695a03c96d9c3760d78efce65a7699` の日報アプリで13ファイル・
230,766バイト・3,398式・11画面・280コントロールを確認しました。
直接の `Navigate` 遷移は12件、履歴依存の `Back` は5件（呼び出し合計17）。
`Back` の行き先を確定した辺として扱いません。全3,398式を分類し、復元を阻害する静的依存の欠落は0件です。実行時依存1,484件は未検証として保持し、解析は `incomplete`、ソース限定スナップショットは許可します。全依存の証拠は `docs/powerapps-dependency-inventory.json` を参照してください。
`inspect:local` はウォームアップ後5回の解析時間・影響分析時間・heap使用量も出力します。

Power Apps、Power Automate、Copilot StudioからHTTPSで呼び出せるNode.js/Express Bridge APIです。

## 前提

- 業務データの正本はSharePoint Listsです。このリポジトリの `data/tasks.json` はローカル開発・テスト用のキャッシュであり、本番の正本ではありません。
- 外部AIのAPIキーやトークンはコード、Git、`.env`に保存せず、デプロイ環境の環境変数へ登録します。
- AIだけで承認を完了させる処理は実装していません。`approval_required=true` は `人間承認待ち` になります。

## 実行

```bash

npm install
cp .env.example .env
npm test
npm start
```

`.env` はGit管理対象外です。`HOST` の既定値はクラウドコンテナ向けの `0.0.0.0`、`PORT` は実行環境の値を優先します。`WEBHOOK_API_KEY` と `MCP_API_KEY` を設定した場合、対象APIは `X-API-Key` ヘッダーを要求します。CORSは `CORS_ORIGINS` に列挙したOriginだけを許可します。

## API

`GET /health`、`GET /api/tasks`、`GET /api/next`、`POST /webhooks/claude-code`、`POST /webhooks/copilot`、`POST /api/tasks/:id/status`、`POST /mcp` を提供します。`retry_count >= 3` は自動的に `停止`、承認要求とユーザー操作要求はそれぞれ待機状態になり、完了・停止・待機中のタスクは `/api/next` から除外されます。対象がなければ `タスクなし` を返します。

`POST /mcp` はChatGPT・Claude Code・CN_総合秘書AIが共通で使うMCP風エントリポイントです。`{"method": "health_check" | "get_tasks" | "get_next_task"}` を受け付け、対応するREST APIと同じ結果を `result` に返します（3AI共通Bridge標準機能）。それ以外の `method` は `400` です。

`create_task` / `update_task_status` / `get_task_result` の3ツールも同じ `POST /mcp` から利用できます。

- `create_task`: `params.title`（必須）・`params.description`（任意）・`params.priority`（任意、既定値 `normal`）で新規タスクを登録し、`result.task_id` と `result.task` を返します。初期ステータスは `未着手` です。
- `update_task_status`: `params.task_id`（必須）・`params.status`（必須、既存のstatus一覧のいずれか）・`params.result`（任意）でタスクの状態と結果を更新し、`result.task` を返します。`task_id` が存在しない場合は `404` です。
- `get_task_result`: `params.task_id`（必須）で現在の `status`・`result` を返します。`task_id` が存在しない場合は `404` です。

## 検証・デプロイ・権限の9ツール

`POST /mcp`（JSON-RPC `tools/call` と legacy `{method, params}` の両形式）と `GET /mcp/tools/list` から使えます。各ツールの `inputSchema` は `additionalProperties: false` で、未定義のプロパティは実行時にも拒否します。エラーは既存規約どおり、`tools/call` は HTTP 200 + `isError:true`、legacy 形式は HTTP ステータス（400/403/404/409/502/503）で返します。

| ツール | 内容 |
|---|---|
| `validate_powerapps_change` | 変更前検査。branch・relativePath・対象ファイル・削除・大規模差分・構文・秘密値混入。`valid` / `errors` / `warnings` / `summary` を返す |
| `run_powerapps_tests` | 静的検査（構文・括弧・引用符・重複定義・画面遷移・データソース参照・危険な削除）。検証材料がない項目は `skipped` + `reason` |
| `verify_save_result` | 保存後に正本ソースとアプリ状態を再取得し、branch・パス・期待SHAまたは内容・状態を検証 |
| `deploy_to_test` | 構成済みの非本番テスト環境へ GitHub Actions の workflow_dispatch を要求 |
| `verify_deployment` | 環境・バージョン・デプロイ結果・health の HTTP 状態と応答内容を検証 |
| `get_deployment_logs` | workflow run / job / step と、任意でjobログ末尾を取得。秘密値はマスク |
| `rollback_deployment` | 確認済み（`verify_deployment` で verified）の復旧元へ戻し、health を再確認。本番は `approvedByHuman:true` 必須 |
| `get_permissions` | 構成済み対象の権限を読み取り専用で取得（対象種別・取得範囲・現在権限） |
| `update_permissions` | `approvedByHuman:true` 必須。最小権限のみ付与・取消し、変更前後を検証 |

### 未構成時の動作

未設定の外部設定がある場合は、ダミー成功にせず HTTP 503（`tools/call` では `isError:true`）で次を返します。

```json
{ "error": "未構成のため実行できません: ...", "status": "not_configured", "reason": "...", "missingConfiguration": ["DEPLOY_GITHUB_TOKEN", "..."] }
```

設定項目は `.env.example` の「デプロイ連携」「権限管理」を参照してください。

### 検証の限界（`run_powerapps_tests`）

Power Apps Studio / Test Engine は実行しません（常に `power_apps_test_engine` が `skipped`）。結果は `passed`（全項目成功）・`failed`（1項目でも失敗）・`incomplete`（失敗はないが未検証項目あり）のいずれかで、`incomplete` は成功扱いではありません。画面遷移は `knownScreens`、データソース参照は `knownDataSources` を渡した場合のみ厳密に検証します。

### デプロイの契約（`deploy_to_test` / `rollback_deployment`）

- 実行基盤は GitHub Actions です。`DEPLOY_TEST_WORKFLOW`（本番ロールバック用に `DEPLOY_PRODUCTION_WORKFLOW`）に指定した workflow は `workflow_dispatch` の入力 `environment` と `git_ref`（コミットSHA）を受け取り、指定コミットを指定環境にだけ配備してください。**このリポジトリにはそのworkflowは含まれていません。別途用意が必要です。**
- `deploy_to_test` は、本番（環境名が本番設定と同じ、または `prod` を含む）・未構成の環境名・許可branch以外・テスト環境設定が本番と同一/本番相当の場合を拒否します。
- `rollback_deployment` の復旧元は、実行履歴（`data/deployments.jsonl`）に記録され、`verify_deployment` で `verified` になった実行のみです。復旧後の health 再確認は workflow 完了を意味しません（完了は `verify_deployment` で確認）。
- `data/deployments.jsonl` はローカル履歴です。複数インスタンスや再デプロイで失われる環境では、復旧元が見つからず拒否されます（安全側の動作）。

### 権限管理の対象

- `powerapps_app`: 構成済みアプリの共有権限（付与できるロールは `CanView` / `CanEdit` のみ）。
- `dataverse_user_roles`: 指定ユーザーの Dataverse セキュリティロール（`PERMISSIONS_ALLOWED_DATAVERSE_ROLES` の許可リストにあるロールのみ）。
- 次は承認済みでも常に拒否します（上書きフラグはありません）: System Administrator / System Customizer / Delegate / `admin` を含むロール名、テナント全体への共有、`#EXT#` を含む外部ユーザーや許可ドメイン外のメールアドレス。
- オブジェクトID（GUID）での指定は、外部ユーザーかどうかを判定できないため、応答の `warnings` にその旨を返します。
- **Power Apps 管理 API / Dataverse の権限関連エンドポイントとの結合は、テストではモックでのみ確認しています。実環境での動作は未確認です。**

### 正本branch保護（過去branchへの誤書き込み防止）

`PowerAppsGitStore` はソースが見つからない場合に過去branch（フォールバック）を探しますが、**更新は正本branch（`POWERAPPS_GITHUB_BRANCH`）にあるファイルに対してのみ**行います。フォールバック先でしか見つからないソースへの `update_powerapps_app` は 409 で拒否し、GitHub への書き込みも Power Platform 同期も行いません。`get_powerapps_source` は `branch` / `canonicalBranch` / `isCanonicalBranch` を返します。`update_powerapps_app`・`save_powerapps_app`・`publish_powerapps_app` は任意の `branch`（`get_powerapps_source` が返した値）を受け取り、正本と異なれば拒否します。`branch` 未指定の呼び出しは従来どおりです（ただし更新時のフォールバック書き込み拒否は常に有効）。

## 開発

```bash
npm test                 # 全テスト
npm run test:mcp-tools   # 追加9ツール関連のテスト
npm run test:safety      # 正本branch保護のテスト
npm run validate:openapi
```

## Power Platform

OpenAPI 3.x定義は [openapi.yaml](openapi.yaml) です。公開ホストが未確定のため `servers` は未指定です。Custom Connector作成時に実際のHTTPS Hostを設定し、まず `GET /health` を接続試験に使ってください。TLS終端、DNS、ファイアウォール、認証キーの安全な登録、SharePoint Listsアダプターの実装は公開前に別途必要です。
