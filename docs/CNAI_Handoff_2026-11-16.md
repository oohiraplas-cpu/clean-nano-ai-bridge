# CNAI 引き継ぎメモ（2026-11-16 時点・秘密値なし）

実測は本番Bridgeの読取り専用ワークフロー（bridge-read.yml）で取得。値は取得時点のもの。判断前にBridgeから再取得すること。

## 確認済み（実測）
- /health と health_check: HTTP 200 / status ok
- cnai_status: status ok / verificationStatus VERIFIED / version 1.1.0
- 本番 deploymentSha: 96c73816462a01424c9bd99e47410d863062ce7e（手元mainと一致）
- ローカル npm test: 1777件すべて成功（失敗0）
- 対象アプリ: 表示名「clean nano kk」 appId f42a9b03-59b9-49d3-a33b-0a210cd3d51e / environmentId 4d0aab59-43ec-ecf1-a9d1-869f2517adbb / 最終更新 2026-11-15T15:29:36Z
- ソリューション: CN_AIIraiDaicho（CN_AI依頼台帳 v1.0.0.2）, CNPowerAppsAutomation ほか
- resolve_app_target は「CN_AI依頼台帳」で not_found（ソリューション名のため）。appId指定なら解決可能

## 書込み条件（get_powerapps_source の実取得）
provider=GitHub / repository=clean-nano-ai-bridge / branch=main / canonicalBranch=main / isCanonicalBranch=true / sourceState=github_canonical / writable=true / holdReason=null / powerAppsAuthority=github_only
注意: stateContext の有効期限は5分。保存・公開の前に再取得が必要。

## 画面（正本ソース powerapps/CN_AI依頼台帳/Source、18画面）
MainScreen1(2799行), Screen1, S1_Home, S2_Calendar, S3_Register, S4_Summary, S5_Salary, S6_Members, S7_Settings, S8_UserOnboarding, S9_UserConfirm, S10_RegistrationComplete, S11_Report, S12_EquipmentOCR, S18_OcrReadPreview, S19_OcrFinalPreview, S8_Nippo, Screen2
- _EditorState の ScreensOrder は先頭13画面まで確認（残り5画面の順序は未確認）
- 命名の揺れ: S8が2つ、Screen1/Screen2/MainScreen1

## 未完了・未確認
- 実機の画面一覧との照合: 未実施。discover_powerapps_structure は /mcp（MCP_API_KEY）側のみで、読取り専用コネクタ（/connector/mcp）では呼べない
- Power Apps 側の実機確認は Copilot の担当領域
- update / save / publish は一切実行していない

## 次の作業案
1. 実機の画面一覧を取得して上記18画面と照合（Studioのツリービュー、または読取り専用ワークフローの追加）
2. MainScreen1（2799行）の分割要否と、命名の整理方針を判断
3. 変更する場合は 変更前保全 → 最小差分 → 保存後に再取得して照合

## 役割
ChatGPT=判断・仕様 / Claude=コード・GitHub・テスト / Copilot=M365・Power Platform実環境。いずれもBridgeの実測値と承認ゲートを迂回しない。
