# CN_AI依頼台帳 公開 証跡 (2026-10-11)

## 対象
- App ID: f42a9b03-59b9-49d3-a33b-0a210cd3d51e
- Environment ID: 4d0aab59-43ec-ecf1-a9d1-869f2517adbb
- Branch: main (canonical), gitRoot: powerapps/CN_AI依頼台帳/Source

## 前提確認（公開直前）
- 最新state read: correlationId 800e5948-2ba9-4153-93c2-4c08cbbe9477（stateSessionId c4e601e1 を発行）
- source-bound session: stateSessionId c4e601e1-06ce-4016-b945-5ff1dedb260b
- sourceObservationComplete=true, stateContextComplete=true（同一session・source read結果）
- stateContext.sha（main commit）= 61412575d571dc557b68a62d7cb25163b7f48710
- deployment SHA = 61412575d571dc557b68a62d7cb25163b7f48710（一致）
- runtime SHA: 61412575（Bridge deployment metadata。独立probe未構成・未確認）

## 実行
- publish_powerapps_app: status ok, operationId f04bb14b-fa43-4650-aecb-dfdb2b251e69, 「公開に成功しました」

## 公開後確認
- get_powerapps_operation_result: operationStatus=success, publishedVersion(記録)=2026-10-05T08:51:35Z, publishedAt=2026-10-11T05:25:39Z
- get_powerapps_app: versionNumber=2026-10-10T17:21:11Z（公開前 2026-10-05T08:51:35Z から変化）
- 注意: operation結果の publishedVersion と app versionNumber が一致していない。原因は未確認。
- get_powerapps_state: correlationId e0ebc1c2-1a35-4731-b450-88e90d7cd660, stateContext.sha=61412575…, deploymentSha=61412575…（state readの sourceObservationComplete/stateContextComplete は false: 仕様どおり）
- health_check: ok

## E2E
- 機能E2E（画面操作・データ確認）は本作業の範囲外で未実施。

## 未確認
- runtime SHA の独立確認（デプロイログ未構成）
- operation結果とapp versionの不一致の原因
- 実機画面での動作確認
