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

### 4.4 未設定時の影響（テスト根拠）
- `test/dependencyHealthCheck.test.js` が `dependencies.powerAutomate.optional === true` を検証している。
- 未設定時も `health_check` の全体判定は、Power Automate を除く依存先（Power Apps / SharePoint / Git / Azure）で判定される。
- 既存テスト 1591 件 PASS（2026-10-25、main `686868b`）。

### 4.5 GitHub 側の設定確認（未確認）
- GitHub Actions の Secret / Variable の一覧 API は、この環境の proxy により 403 で拒否される。
- そのため、GitHub 側に `POWER_AUTOMATE_FLOWS` が登録されているかは **未確認**。登録済みであれば Azure 側と同じ値を使うため、確認は Azure / GitHub の管理者画面で行うこと。

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
| PARTIAL | 一部の依存先（例: Power Automate のみ）が未確認または BLOCKED で、それ以外は PASS。未確認部分を明記する |
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

## 10. CNAI から Bridge までの実行経路（コード根拠）

CNAI（ChatGPT / Claude / Copilot）→ Clean Nano AI Bridge（`/mcp`、`MCP_API_KEY` 認証）→ Power Apps / Power Automate / SharePoint / GitHub / Azure。

### 10.1 Power Apps（`src/server.js`）
- 読取: `powerapps_app_read`
- 編集・保存・公開: `powerapps_app_edit_publish`（保存スナップショットを作成）
- 戻し: `powerapps_app_rollback`（保存済みスナップショットへ戻して公開）
- 一覧: `powerapps_snapshots_list`
- 正本: GitHub `main`、root は `powerapps/CN_AI依頼台帳/Source`。書込みは `canonicalBranch=main` かつ `writable=true` の実取得確認が前提。

### 10.2 Power Automate（`src/server.js`、`src/powerAutomateRunner.js`）
- 一覧: `powerautomate_flow_list` / 登録済み一覧 `list_registered_power_automate_flows`
- 読取: `powerautomate_flow_read`
- 更新: `powerautomate_flow_update`（保存スナップショットを作成）
- 状態変更: `powerautomate_flow_set_state`
- 戻し: `powerautomate_flow_rollback`
- 実行: `run_power_automate_flow`（`approvedByHuman:true` 必須）
- 注意: 上記の実環境での動作は、本番ホストに到達できないため **未確認**。コード上の経路の存在のみ確認した。

### 10.3 SharePoint / GitHub / Azure
- SharePoint の読取は `SHAREPOINT_*` 設定を再利用。
- GitHub は `POWERAPPS_GITHUB_*` と `DEPLOY_*` で構成。Azure の App Settings はこのチャットからは未確認。

## 11. 検証証跡の記録方法
- 実行日時、main の SHA、PR 番号、テスト件数（`npm test` の `# pass` / `# fail`）を記録する。
- 秘密値・トリガー URL・SAS は記録しない（件数や有無のみ）。
- 未確認項目は「未確認」と明記し、推測で埋めない。

## 12. 最終判定（2026-10-25 時点）

- 判定: **PARTIAL**
- main SHA: `686868b`（PR #183 のマージ commit）
- PR #184（Runbook 検証更新）: CI `test` 2 件 SUCCESS、mergeable、競合なし、差分は Runbook 1 ファイル（+43 行）。Secret らしき文字列の検査で該当なし。**マージは未実施**（自動安全機構により拒否。人間の承認・操作待ち）。
- CNAI 側の実測（CNAI からの報告値。本セッションからは本番未到達のため未再確認）:
  - `health_check` = PASS、`get_bridge_capabilities` = PASS、`check_dependencies` = PASS（再実行後も PASS）
  - Power Apps = OK、SharePoint = OK、Git = OK（branch: main）、Azure = dependency failure なし
  - Power Automate = NOT_CONFIGURED（optional）
- `POWER_AUTOMATE_FLOWS`: 未設定のまま。値は推測・生成していない。既存リポジトリに再利用可能な確定値なし。
- PARTIAL の理由: Power Automate の HTTP トリガー実行設定が未構成（optional）。Power Automate の実環境での読取・更新・保存後再取得は本セッションから未確認。
- 既存テスト: 1591 PASS / 0 FAIL（main `686868b` 相当の作業ツリーで確認済み）。

## 13. 保存後再取得・rollback・Secret 保護
- 変更は Git の commit として保存し、push 後に GitHub の差分・CI で再取得して確認する。
- rollback: 問題があれば該当 PR を revert する（main への直接変更は行わない）。
- Secret: 値・SAS・トークンは本文、ログ、PR、commit に含めない。検査は差分の正規表現で行う。

## 14. 停止条件（再掲）
- main へのマージ、本番公開、権限変更、追加課金、Premium 追加、物理削除、Secret の表示・保存、未確認値の推測。
- 上記に該当する場合は、人間の承認を得てから実施する。

## 15. Golden Path（標準実行経路）

通常の Power Platform 変更は、この順序を正本とする。例外時のみ fallback を使う。

DISCOVER → IDENTITY LOCK（repository / main SHA / branch / Environment / App ID or Flow ID / path を固定）→ SNAPSHOT → DEPENDENCY CHECK → PLAN → PRE-VALIDATE → CHANGE → VALIDATE → TEST → SAVE → RE-READ → DIFF → RECOVERABILITY CHECK → AUDIT → DONE

- 古い SHA は拒否する。
- Validate 前に変更しない。
- Save 後は必ず Re-read し、期待値と実取得結果が一致した場合のみ DONE とする。Save 成功レスポンスだけでは DONE にしない。
- Re-read 不一致は DONE にしない。

### 15.1 Contract Test（CI で検出する契約）
`test/goldenPathContract.test.js`（4 件）で次を検証する。
- 不正な `POWER_AUTOMATE_FLOWS` で起動を落とさず、空として扱う
- 未設定の flowKey は外部へ送信せず拒否する
- エラー応答にトリガー URL（SAS）を含めない
- 依存確認の出力にトリガー URL を含めない（optional 依存でも Secret を漏らさない）

テストには実在しないダミー URL のみを使い、実値は使わない。

### 15.2 能力判定の区別
- PASS: 実経路と検証が成功
- PARTIAL: コードの存在のみ、または実環境の検証が未実施
- BLOCKED: 外部条件（本番到達不可、権限、Secret 入力が必要など）で実行不能
- NOT_NEEDED: 今回の目的上不要

コードの存在だけでは PASS にしない。

### 15.3 本セッション時点の状態（2026-10-25）
- main: `6588b55`（PR #184 マージ後）
- 既存テスト 1591 PASS + 新規 Contract Test 4 PASS = 1595 PASS / 0 FAIL
- Power Apps / Power Automate の実環境 E2E（save → re-read）: **未実施**（本番ホストに到達できないため BLOCKED）
- POWER_AUTOMATE_FLOWS: 未設定（optional）。値は推測・生成していない
