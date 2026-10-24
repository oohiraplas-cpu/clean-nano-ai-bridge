# CNAI Bridge 障害切り分け・復旧 Runbook

対象: clean-nano-ai-bridge（正本 branch: `main`）
作成根拠: 2026-10-25 時点の `main`（HEAD f2e05b1）のソース確認と、既存テスト（`npm test` 1591件 PASS）の実行結果。

## 0. 原則

- 既に PASS している Power Apps / SharePoint / Git / Azure の設定は変更しない。
- 新規 MCP は追加しない。Bridge の再構築はしない。
- 秘密値（API キー、SAS 付きトリガー URL、PAT、トークン）を表示・ログ・コミットしない。
- 未確認の値を推測しない。必要な値が確認できない場合は BLOCKED とする。
- 本番公開、main への無確認マージ、権限変更、物理削除、Premium 追加、追加課金は行わない。

## 1. 障害切り分け順序

上から順に確認する。前段が FAIL の場合、後段の結果は参考値として扱う。

1. Bridge 本体の疎通（`health_check`）
2. 機能一覧と設定種別（`get_bridge_capabilities`）
3. 依存先の状態（`check_dependencies`）
4. 依存先ごとの詳細（Power Apps → SharePoint → Git → Azure → Power Automate の順）
5. 未設定項目の診断（Section 4 の `POWER_AUTOMATE_FLOWS` 診断）
6. 再検証（Section 5）

## 2. 各確認ツール

### 2.1 health_check
- 目的: Bridge が応答し、本体が起動しているか。
- 期待値: 応答 OK。
- 注意: Bridge 全体の正常判定には全依存先が健全である必要がある（`server.js` の説明文どおり）。

### 2.2 get_bridge_capabilities
- 目的: 提供機能と依存先の設定状態の一覧取得。
- 確認点: `dependencies.powerAutomate` が `not_configured` かつ `optional: true` であるか。
- 参照ソース: `src/bridgeCapabilities.js`（Power Automate は未構成でも任意扱い）。

### 2.3 check_dependencies
- 目的: Power Apps / SharePoint / Git / Azure / Power Automate の依存先を個別に判定。
- 判定の読み方:
  - `ok` … 正常
  - `not_configured` … 未設定（`missingConfiguration` に不足項目名が出る。値は出ない）
  - `error` … 設定はあるが応答が不正（上流応答・権限・ネットワークを確認）

## 3. 依存先ごとの注意

- Power Apps: 正本は GitHub `main`、root は `powerapps/CN_AI依頼台帳/Source`。書込みは `canonicalBranch=main` かつ `writable=true` の実取得確認が前提。
- SharePoint: 読取りは `SHAREPOINT_*` 設定を再利用。列の内部名は推測しない。
- Git: `main` の HEAD を確認する。作業 branch と本番 branch を混同しない。
- Azure: 本番ホスト名は `clean-nano-ai-bridge-c7evcxhtergad9b0.westus3-01.azurewebsites.net` を使う（旧ホスト名 `clean-nano-ai-bridge.azurewebsites.net` は使わない）。

## 4. POWER_AUTOMATE_FLOWS 診断

### 4.1 仕様（コード根拠）
- 参照箇所は次の 2 か所のみ。
  - `src/config.js`: `parsePowerAutomateFlows(env.POWER_AUTOMATE_FLOWS)` で読み込む
  - `src/powerAutomateRunner.js`: `healthCheck()` が未設定を `not_configured` と判定
- 想定 schema: `{"flowKey": "HTTP要求受信時トリガーURL"}` の JSON オブジェクト。
- 必須/任意: Bridge 全体としては **任意**（`bridgeCapabilities.js` が `optional: true` で扱う）。
- fallback: 未設定・JSON 不正・配列の場合は空オブジェクト `{}` として扱い、起動は止めない。
- 実行系: `runFlow()` は flowKey 未登録なら例外を投げ、外部には送信しない（安全側に失敗）。
- 実行は人間承認（`approvedByHuman:true`）が必須。

### 4.2 不足設定の確定
| 項目 | 内容 |
|---|---|
| 不足設定 | `POWER_AUTOMATE_FLOWS`（App Settings） |
| 設定元 | Azure App Service の App Settings（Secret 扱い）。`.env.example` は空のまま |
| 必要な形式 | JSON 文字列 `{"flowKey":"https://...トリガーURL"}`（複数可） |
| 値の入手元 | Power Automate の各フロー「HTTP要求受信時」トリガーの URL（SAS 署名を含む） |
| 安全に自動設定可能か | **不可**。値は SAS 付き機密情報で、リポジトリ・既存メモ・既存設定から再利用できる値は確認されていない。推測・生成は禁止 |

### 4.3 判定
- 未設定のままでも Bridge の基本機能は動作する（任意依存）。
- 設定する場合は、フロー所有者が trigger URL を Azure App Settings に直接登録し、Bridge 側で値を表示しない。
- 値が確認できない限り、Power Automate 関連の完了判定は BLOCKED とする。

## 5. 再検証

1. `npm test` を実行し、全件 PASS を確認する（現時点の期待値: 1591 件 PASS）。
2. `node --test test/powerAutomateFlowWriter.test.js test/dependencyHealthCheck.test.js` を実行する。
3. 本番で `health_check` → `get_bridge_capabilities` → `check_dependencies` を順に実行する。
4. Power Apps / SharePoint / Git / Azure の状態が変更前と同一であることを確認する（unexpected changes = 0）。
5. Power Automate を設定した場合のみ、`list_registered_power_automate_flows` で登録件数を確認する（URL は表示されない想定）。

## 6. PASS / FAIL / BLOCKED 基準

| 判定 | 条件 |
|---|---|
| PASS | 対象の health/check が期待値どおり。テスト全件 PASS。意図しない変更なし |
| FAIL | 既存の正常項目が悪化した。テストが失敗した。意図しない変更が検出された |
| BLOCKED | 必要な値・権限・接続（本番疎通、トリガー URL など）が確認できず、安全に進められない |

Power Automate が未設定のみの場合は、任意依存のため **PASS（optional 未設定）** と記録し、Power Automate 機能は BLOCKED と併記する。

## 7. ロールバック

- コード: 変更は作業 branch で行い、`main` へは PR 経由・人間承認後にのみ反映する。問題があれば PR を revert する。
- App Settings: `POWER_AUTOMATE_FLOWS` を追加した場合は、追加前の状態（未設定）に戻す。変更前の値は記録しておく（値そのものは記録に残さない）。
- 反映後は `health_check` と `check_dependencies` を再実行して元の判定に戻ったことを確認する。
- Azure 側の設定変更・再起動は、対象操作への人間承認を得てから行う。

## 8. Secret 非保存ルール

- 秘密値（`MCP_API_KEY`、`WEBHOOK_API_KEY`、SAS 付き trigger URL、`*_PAT`、`*_TOKEN`）をコード・Markdown・ログ・コミット・チャットに出力しない。
- 既に平文で出た値は、再発行の要否を管理者が判断する（変更は承認後）。
- ログには `secretMasking` を通した値のみ残す。

## 9. 停止条件（この作業で即時停止し、人間の判断を仰ぐ）

- Premium コネクタ・Premium 機能の追加が必要になった場合
- 権限変更（ロール付与・削除、アクセス許可の変更）が必要になった場合
- 削除操作（物理削除を含む）が必要になった場合。削除 API は使用禁止
- 本番公開（publish、deploy_to_test 以外の本番デプロイ）が必要になった場合
- main への無確認マージが必要になった場合
- 追加課金・契約が発生する場合
- 秘密値の表示・推測が必要になった場合
- 既存の PASS 項目に変更が生じた場合
