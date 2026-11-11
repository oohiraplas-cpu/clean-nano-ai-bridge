# 公開ゲート再設計 証跡 (2026-10-11)

契約: publish_powerapps_app `PUBLISH_CONTRACT_VERSION=2026-10-11` / capabilities `schemaVersion=2026-10-11`

## 原因（確認済み）
1. `get_powerapps_state` は source を bind しないため、`sourceObservationComplete` / `stateContextComplete` は常に false。
2. StateContext の `sha` は branch commit SHA だが、State Registry の validate は file blob SHA と比較していたため、source 観測を伴う validate 系は常に SHA 不一致で拒否されていた（read-only 検証で再現）。
3. `publish_powerapps_app` は state を検証していなかった（branch 指定のみ）。

## 変更
- commit SHA と blob SHA の比較を分離（`src/stateContext.js` validate、`src/server.js` validate 系ライブ検証）。
- publish: source-bound・未期限切れの stateSessionId を必須化（`src/server.js` executeWithStateInternal）。
- publish 直前に App ID / Environment ID / 正本 commit / 正本 branch / 観測 blob / 観測 branch を再確認。
- `DEPLOYMENT_SHA`（`config.deploymentSha`）と canonical commit SHA を照合。
- 旧 caller（stateSessionId なし）は `428 state_session_required` で明示拒否。フォールバックなし。
- 既存テスト2件は旧契約（commit=blob を前提）を前提としていたため、新契約へ更新（理由はコメント参照）。

## テスト
- 新規 `test/publishGate.test.js`: 13件（401、stateSessionId なし、期限切れ、source 未観測、commit 不一致、blob 変更、App ID 不一致、Environment ID 不一致、非 canonical branch、DEPLOYMENT_SHA 不一致/未設定、全一致時のみ公開到達、validate 系3経路の分離）
- `npm test`: 1305 / 1305 成功（CI 相当の環境変数でも 1305 / 1305）
- `validate:openapi`: 成功
- `test:mcp-tools`: 146 / 146
- `test:safety`: 9 / 9

## 未対応・注意
- `prepare_powerapps_execution` 系（`src/server.js` 付近の `stateRegistry.bind`）にも commit/blob の混同が残っている。今回の範囲外のため未修正。
- `get_bridge_capabilities` の `deploymentSha` は null のまま（今回未配線）。
- 公開の実環境反映は未実施（保存・公開・Production 変更なし）。
