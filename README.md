# clean-nano-ai-bridge

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

- `create_task`: `params.title`（必須）・`params.description`（任意）・`params.priority`（任意、既定値 `normal`）・`params.source`（任意、`chatgpt` / `claude-code` / `copilot`、既定値 `chatgpt`）で新規タスクを登録し、`result.task_id` と `result.task` を返します。初期ステータスは `未着手` です。`source` は自己申告値で、本人確認には使いません。
- `update_task_status`: `params.task_id`（必須）・`params.status`（必須、既存のstatus一覧のいずれか）・`params.result`（任意）でタスクの状態と結果を更新し、`result.task` を返します。`task_id` が存在しない場合は `404` です。
- `get_task_result`: `params.task_id`（必須）で現在の `status`・`result` を返します。`task_id` が存在しない場合は `404` です。

## 3AIの接続と検証

- ChatGPT: 既存の「あか」MCP接続を使い、`create_task` / `get_tasks` / `get_task_result` を呼びます。新しいBridgeは作成しません。
- Claude Code: 既存の `POST /webhooks/claude-code` に `id` と `title` を含むJSONを送ります。Bridgeが `source=claude-code` を設定します。
- Microsoft 365 Copilot / CN_総合秘書AI: Copilot Studioの既存カスタムコネクタ `CN_AI_Bridge`（または現在使用中の既存接続）で `invokeMcpBridge` を呼び、`method=create_task`、`params.source=copilot` を渡します。代替経路の既存 `POST /webhooks/copilot` でも `source=copilot` を記録します。Microsoft 365 Copilotの契約だけでCopilot Studioの自律実行やクレジットが無償になるとは仮定しません。
- 3者のタスクは設定済みの同じ `TASK_STORE_BACKEND` へ入ります。本番正本をSharePoint Listsにする場合、現場のリストID・列内部名・権限を実測してから `TASK_STORE_BACKEND=sharepoint` を設定します。ローカルの `data/tasks.json` を本番正本と見なしません。
- `MCP_API_KEY` が設定されている環境では `/mcp` に `X-API-Key` が必要です。既存ChatGPT接続がこのヘッダーを送れるか、またはAzure側の認証経路を使うかをデプロイ前に確認します。キーの設定状況と `/api/tasks` 等の既存REST経路の公開範囲も点検してください。キーをコードや文書に記載しません。
- GitHub ActionsのPRテストで同じ台帳への受付・送信元・承認待ち停止を検証します。これはCopilot Studioでの実動作、Power Appsへの保存、SharePointの実列、隔離環境での復元を証明しません。実接続の確認が済むまで本番公開しません。

### 読み取り専用の接続診断

MCP `get_bridge_readiness` は、認証設定の有無、タスク保存先の種類、SharePoint・Power Apps・登録フローの設定有無を返し、選択中のタスク保存先に対して `list()` を試します。認証情報、URL、上流のエラー本文は返しません。`configured` は設定値の存在だけ、`probes.taskStore` はその時点の読み取り疎通だけを示します。SharePointリストの列、Power Apps、Power Automate、Copilot Studioとの接続まで正常と判定するものではありません。

2026-09-28 の環境調査では、Copilot Studioの `CN_総合秘書AI` は Default 環境、`CN_AI依頼台帳` は clean nano 環境にありました。Default 環境の `CN_AI実行ゲートウェイ` はオフ、Power Apps V2トリガーのみの下書きで、接続参照・実行履歴がありません。エージェント上のBridgeツールは表示されてもチャットからの実呼び出しに失敗しました。この差分を解消し、実際のデータソースと認証を確認するまでは、自律実行の完了を宣言しないでください。

## Power Platform

OpenAPI 3.x定義は [openapi.yaml](openapi.yaml) です。公開ホストが未確定のため `servers` は未指定です。Custom Connector作成時に実際のHTTPS Hostを設定し、まず `GET /health` を接続試験に使ってください。TLS終端、DNS、ファイアウォール、認証キーの安全な登録、SharePoint Listsアダプターの実装は公開前に別途必要です。
