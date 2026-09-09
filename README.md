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

## Power Platform

OpenAPI 3.x定義は [openapi.yaml](openapi.yaml) です。公開ホストが未確定のため `servers` は未指定です。Custom Connector作成時に実際のHTTPS Hostを設定し、まず `GET /health` を接続試験に使ってください。TLS終端、DNS、ファイアウォール、認証キーの安全な登録、SharePoint Listsアダプターの実装は公開前に別途必要です。