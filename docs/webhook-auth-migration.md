# Webhook 認証の移行手順

対象: `POST /webhooks/claude-code`、`POST /webhooks/copilot`（`WEBHOOK_PATHS` が正）。

## 現状（既定: compat）
- `WEBHOOK_API_KEY` が未設定のとき、Webhook は認証なしで通ります（従来の挙動。呼出元を壊さないため維持）。
- 設定済みのときは、`x-api-key` ヘッダー、`Authorization: Bearer`、`?api_key=` のいずれかで認証します。

## 移行先（enforce）
- 環境変数 `WEBHOOK_AUTH_MODE=enforce` を設定すると、`WEBHOOK_API_KEY` 未設定の Webhook は 503 で拒否します（fail closed）。
- 鍵が設定されているときの挙動は compat と同じです。

## 切替前の確認（人間の作業）
1. 呼出元（Power Automate フロー、Copilot Studio、その他）を一覧化する。このリポジトリからは呼出元を確認できないため、各所で確認が必要です。
2. すべての呼出元が `WEBHOOK_API_KEY` を送っていることを確認する（鍵を送っていない呼出元は、enforce で必ず失敗します）。
3. ステージングで `WEBHOOK_AUTH_MODE=enforce` を試し、呼出元の成功を確認する。

## 切替（本番影響があるため、承認後に人間が実施）
1. App Service に `WEBHOOK_AUTH_MODE=enforce` を設定して再起動する。
2. 呼出元の失敗（HTTP 401/503）がないことを確認する。
3. 問題が出た場合は `WEBHOOK_AUTH_MODE` を削除（compat に戻る）して再起動する。

## 注意
- 鍵の値を Git、ログ、URL のクエリ、Artifact に書かない。
- 既存の鍵の失効・ローテーションは `docs/mcp-key-rotation.md` の手順に従い、別途承認を得て行う。
