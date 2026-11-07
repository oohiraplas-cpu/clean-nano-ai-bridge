# Webhook 呼出元の調査（リポジトリ内・実施日 2026-11-07）

対象: `POST /webhooks/claude-code`、`POST /webhooks/copilot`（`WEBHOOK_PATHS` が正）。
方針: 本番の enforce 切替は行わない。この文書は「確認できたこと」と「確認できないこと」を分けて記録する。

## 1. 確認できたこと（リポジトリ内の実測）

| 場所 | 内容 | 影響 |
|---|---|---|
| `src/server.js:171,3013` | 本番エントリ（`npm start` / `package.json` の main）。`WEBHOOK_PATHS` で2経路を登録し、`webhookAuthGate` で認証（compat / enforce） | 本番の唯一の経路 |
| `src/completeBridgeServer.js:482-483` | 別系統のサーバー。`/webhooks/*` を登録するが、呼出元は `createApiHandler` で、鍵検査を通らない | 本番エントリからは未使用（下記2参照） |
| `src/completeBridgeApplication.js` | 上記別系統を起動するアプリ。利用箇所は自身のテストのみ | 本番からは未使用 |
| `.github/workflows/clean-nano-bridge-test.yml:108-180` | CI で `/webhooks/claude-code`、`/webhooks/copilot` を curl。`WEBHOOK_API_KEY` をテスト値で設定 | CI のみ。本番ではない |
| `POWERAPPS_INTEGRATION.md:211-212`、`README.md:25`、`CLAUDE.md:35`、`openapi.yaml:35,44` | ドキュメント・Custom Connector 定義 | 利用側の想定。実際の呼出元ではない |
| `test/server.test.js`、`test/webhookAuthMigration.test.js` | 認証の有無・compat/enforce の挙動を検証 | 回帰テスト済み |
| `src/config.js:46,49`、`.env.example:6` | `WEBHOOK_API_KEY`、`WEBHOOK_AUTH_MODE`（既定 compat） | 設定名の確認のみ |

workflow ファイルは計11本を確認した。`clean-nano-bridge-test.yml` 以外に Webhook の呼出しは無い。

## 2. 発見した問題

- **別系統のサーバーの Webhook が鍵検査なし**: `src/completeBridgeServer.js` の `/webhooks/*` は、本番エントリ（`src/server.js`）と違い `WEBHOOK_API_KEY` の検査を通らない。現状は本番から起動されていないが、誤って起動すると鍵なしで公開される。対応案: このファイルを本番から使わないことを明記する、または `webhookAuthGate` を同じように通す（別タスク、未実施）。

## 3. 確認できないこと（実環境が必要・未確認）

- App Service の実際の呼出元（Power Automate の HTTP アクション、Copilot Studio のアクション、Claude Code 側）の一覧。
- 過去の呼出し履歴（App Service ログ・Application Insights）。`azure-readonly-diagnostics.yml` の診断経路で後日取得するまで未確認。
- App Service の `WEBHOOK_API_KEY` / `WEBHOOK_AUTH_MODE` の現在値（値は取得しない。名前の存在のみ診断対象）。

## 4. 移行計画（本番切替はしない）

1. 呼出元の洗い出し: Power Automate のフロー（HTTP アクション）、Copilot Studio のアクション、Claude Code 側の設定を、利用者が一覧に記入する（人間操作）。
2. 各呼出元が `x-api-key` を送っているか確認する（送っていなければ、enforce で必ず 401 になる）。
3. ステージングで `WEBHOOK_AUTH_MODE=enforce` を試し、各呼出元の成功を確認する。
4. 本番は承認後に `WEBHOOK_AUTH_MODE=enforce` を設定して再起動する。問題があれば削除（compat に戻る）して再起動する。
5. 別系統サーバー（上記2）の扱いを決めてから、その後の作業を行う。

詳細な切替手順は `docs/webhook-auth-migration.md` を参照。
