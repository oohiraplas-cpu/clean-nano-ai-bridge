# CNAI ChatGPT 実行指示書

## 目的と役割
既存Clean Nano AI Bridge MAXの接続を実測で確認し、既存資産を保全して会社OSの運用を進める。

| 担当 | 責務 |
|---|---|
| ChatGPT | 全体統括・仕様確定・ボトルネック判断・最終検証 |
| Claude | コード・GitHub・テスト |
| Copilot | Microsoft 365・Power Platformの実機操作 |
| Bridge | 実環境の正本情報取得 |

今回の文書登録はユーザーの明示指示によりChatGPTが実施する。役割の指定だけで他AIへの接続・委譲完了と判定しない。

## 対象と開始時の読取り
- repository: oohiraplas-cpu/clean-nano-ai-bridge
- アプリ名: clean nano kk
- appId: f42a9b03-59b9-49d3-a33b-0a210cd3d51e
- environmentId: 4d0aab59-43ec-ecf1-a9d1-869f2517adbb

既存接続を再利用し、認証後は以下を順番に実行する。対象IDを受け付ける操作には上記appIdとenvironmentIdを明示する。
1. health_check
2. resolve_app_target
3. get_powerapps_app
4. get_powerapps_state
5. get_powerapps_source

前段の認証が失敗した場合、依存操作はBLOCKEDとする。別経路の成功をChatGPTのBridge MAX接続成功の代用にしない。

## 正本確認ゲート
実環境の正本確認はBridgeを優先する。過去ログ・記憶・引継ぎ文書を現在の実測値として扱わない。

| 項目 | 必須期待値 |
|---|---|
| provider | GitHub |
| branch | main |
| canonicalBranch | main |
| isCanonicalBranch | true |
| sourceState | github_canonical |
| writable | true |
| holdReason | なし（明示的なnullまたは空。欠落は未確認） |

対象ID・repository・正本パスも照合する。条件不一致、欠落、期限切れ、取得失敗はFail-Closedとし、Power Appsへの書込み・保存・公開を禁止する。
引継ぎ資料に記載されたstateContext有効期限は5分。操作前に現在の契約と有効性を確認し、期限切れなら再取得する。
正本branch=mainは読取り元の条件であり、mainへの直接書込みの許可ではない。

## 運用規則
- READ → WRITE → VERIFY → RELEASE → AUDIT → ROLLBACKを適用する。ROLLBACKは復旧方法と復元可能性を確認し、通常時に不要な本番復元を実行しない。
- 更新前に正本状態・対象・権限・追加費用を検証する。
- Snapshot / Backup、差分、期待値、dry-run、監査と復旧方法を準備する。
- 保存後は再取得し、期待値と比較する。API成功だけでPASSとしない。
- 本番公開・課金・権限変更・秘密値変更は明示承認を必須とする。
- 既存アプリ・ソリューション・ソースを削除・改名しない。
- 旧ブランチ・フォールバックブランチへ書き込まない。
- GitHubは確認済みmainから新規作業ブランチを作り、main向けDraft PRにする。main直接書込み・自動マージは禁止。
- 秘密鍵・APIキー・アクセストークン・認証付きURLをチャット、ログ、文書、PRへ出力しない。診断は秘密値を含まない項目だけ抽出する。
- 未確認をPASSにしない。独立検証は実装者の成功申告だけに依存せず、保存先の再取得・期待値照合・差分・CI証跡で行う。
- BLOCKEDでも安全な独立作業は継続し、必要な本人操作を可能な限り1回にまとめる。

## 未完了課題と画面対応表
1. GitHub正本18画面とPower Apps Studio実機画面の照合。
2. MainScreen1（引継ぎ時点2799行）の分割要否判定。現行ソースの責務・依存・回帰影響を再確認して判断する。
3. S8、Screen1、Screen2、MainScreen1の命名整理方針策定。

既存画面名は変更せず、まず以下の対応表を実機証跡で埋める。画面名と件数はPR #248の引継ぎ記録に基づく照合候補であり、現在の実機確認済みを意味しない。

| GitHub側の既存画面名（引継ぎ値） | Studio実機名 | 照合状態 |
|---|---|---|
| MainScreen1 | 未取得 | BLOCKED |
| Screen1 | 未取得 | BLOCKED |
| S1_Home | 未取得 | BLOCKED |
| S2_Calendar | 未取得 | BLOCKED |
| S3_Register | 未取得 | BLOCKED |
| S4_Summary | 未取得 | BLOCKED |
| S5_Salary | 未取得 | BLOCKED |
| S6_Members | 未取得 | BLOCKED |
| S7_Settings | 未取得 | BLOCKED |
| S8_UserOnboarding | 未取得 | BLOCKED |
| S9_UserConfirm | 未取得 | BLOCKED |
| S10_RegistrationComplete | 未取得 | BLOCKED |
| S11_Report | 未取得 | BLOCKED |
| S12_EquipmentOCR | 未取得 | BLOCKED |
| S18_OcrReadPreview | 未取得 | BLOCKED |
| S19_OcrFinalPreview | 未取得 | BLOCKED |
| S8_Nippo | 未取得 | BLOCKED |
| Screen2 | 未取得 | BLOCKED |

S8_UserOnboardingとS8_Nippoを区別する。各行に実取得日時・ソースSHA・実機証跡を追加してから照合PASSとする。

## GitHub検証と監査
1. main、既存引継ぎ資料、PR #248を確認する。
2. docs/CNAI_ChatGPT_Execution_Instructions.mdを新規ファイルとして作業ブランチへコミットする。
3. 保存先をコミットSHA指定で再取得し、全文一致を検証する。
4. main向けDraft PRを作成する。
5. 変更ファイル・差分・対象HEADのCI結果を確認する。CI未実行・実行中はPASSにしない。
6. 変更対象が文書のみであること、秘密値・対象外変更がないことを確認する。

文書変更の復旧: Draft PRをマージしなければmain・本番には影響しない。必要なら作業ブランチへ打消しコミットを作成する。ブランチや既存資産の削除は行わない。本番Rollbackの実行検証とは区別する。

## 今回の開始時Checkpoint（2026-11-17 JST）
- GitHub main確認SHA: f743f222caa350d1b283d2efb7cd9a111bb0c6fc
- PR #248: merged。docs/CNAI_Handoff_2026-11-16.mdを上記SHAで取得済み。
- ChatGPT Bridge MAX health_check: FAIL（HTTP 401 / UNAUTHORIZED）。
- 残り4操作と正本条件の現在値: BLOCKED（認証未復旧）。
- 接続管理画面・認証履歴: 未取得。このセッションにはブラウザー操作機能が提供されていない。
- 原因確定: 未完了。401のみではキー不一致・認証情報伝達不備・認証層の拒否を区別できない。
- 再開地点: 接続管理で既存接続を再認証し、5操作を順番に実行する。秘密値変更が必要なら明示承認を得る。
- Power Apps更新・保存・公開、本番設定変更: 未実施。

## 完了判定と報告
Bridge認証成功、5読取り操作成功、正本条件一致、指示書保存・再取得一致、Draft PR作成、変更差分・CI・監査確認がすべて揃った場合のみCOMPLETE。
未達はBLOCKEDとして残し、文書の完了と実接続の完了を分離する。

報告順: 結論（COMPLETE / BLOCKED）、確認済み事実、実行結果（PASS / PARTIAL / FAIL）、VERIFY / E2E / AUDIT / ROLLBACK、コミットSHA・PR URL、追加料金、未完了、必要な人間操作。

## 参照
- [PR #248](https://github.com/oohiraplas-cpu/clean-nano-ai-bridge/pull/248)
- [引継ぎ資料](CNAI_Handoff_2026-11-16.md)
