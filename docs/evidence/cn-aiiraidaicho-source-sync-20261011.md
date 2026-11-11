# CN_AI依頼台帳 Source 同期差分 証跡 (2026-10-11)

- 対象: powerapps/CN_AI依頼台帳/Source/ のみ
- 比較元: origin/main (7dcb8fa)、取込元: origin/sync/cn-aiiraidaicho-live-review-20260926 (3c2ae8b)
- 注意: 取込元と main は共通履歴なし。全体diffは182ファイル/52k削除となるため、Sourceフォルダ単位でのみ取込み。
- 削除しない: main にのみ存在する S12_EquipmentOCR / S18_OcrReadPreview / S19_OcrFinalPreview は保持（取込元に無いため差分として残す）。

## 差分 (main 比)
```
 .../Source/App.pa.yaml"                            |   11 +
 .../Source/MainScreen1.pa.yaml"                    | 2585 ++++++++++++++++++++
 .../Source/S10_RegistrationComplete.pa.yaml"       |   56 +
 .../Source/S11_Report.pa.yaml"                     |  462 ++++
 .../Source/S1_Home.pa.yaml"                        |  392 +--
 .../Source/S2_Calendar.pa.yaml"                    |  110 +-
 .../Source/S3_Register.pa.yaml"                    |  441 ++++
 .../Source/S4_Summary.pa.yaml"                     |  297 +++
 .../Source/S5_Salary.pa.yaml"                      |  185 +-
 .../Source/S6_Members.pa.yaml"                     |  195 ++
 .../Source/S7_Settings.pa.yaml"                    |  232 ++
 .../Source/S8_UserOnboarding.pa.yaml"              | 1156 +++++++++
 .../Source/S9_UserConfirm.pa.yaml"                 |   69 +
 .../Source/Screen1.pa.yaml"                        |  443 ++++
 .../Source/_EditorState.pa.yaml"                   |   23 +
 15 files changed, 6191 insertions(+), 466 deletions(-)
 .../Source/App.pa.yaml"                            |   11 +
 .../Source/MainScreen1.pa.yaml"                    | 2585 ++++++++++++++++++++
 .../Source/S10_RegistrationComplete.pa.yaml"       |   56 +
 .../Source/S11_Report.pa.yaml"                     |  462 ++++
 .../Source/S1_Home.pa.yaml"                        |  392 +--
 .../Source/S2_Calendar.pa.yaml"                    |  110 +-
 .../Source/S3_Register.pa.yaml"                    |  441 ++++
 .../Source/S4_Summary.pa.yaml"                     |  297 +++
 .../Source/S5_Salary.pa.yaml"                      |  185 +-
 .../Source/S6_Members.pa.yaml"                     |  195 ++
 .../Source/S7_Settings.pa.yaml"                    |  232 ++
 .../Source/S8_UserOnboarding.pa.yaml"              | 1156 +++++++++
 .../Source/S9_UserConfirm.pa.yaml"                 |   69 +
 .../Source/Screen1.pa.yaml"                        |  443 ++++
 .../Source/_EditorState.pa.yaml"                   |   23 +
 15 files changed, 6191 insertions(+), 466 deletions(-)
```

## 構造解析 (js-yaml 解析・parse error なし)
- App.pa.yaml: App.Properties = Theme のみ。StartScreen 指定なし（先頭画面に依存）。
- 画面数 16、Navigate 遷移 55 件。
- **欠落遷移**: S2_Calendar → Screen2 (OnSelect)。Screen2 ファイルなし。
- **未参照画面**: S12_EquipmentOCR、Screen1（どの画面からも Navigate されない）。
- **遷移元なし**: S9_UserConfirm、S19_OcrFinalPreview、Screen1（Navigate を持たない）。
- _MainScreen の実ファイル名は MainScreen1.pa.yaml。

## 未確認・未実施
- Power Apps 実環境の状態・公開可否は未確認（本作業は公開・反映を行わない）。
- Screen2 の欠落、Screen1 の扱い、S12/S18/S19 の正否は取込元の作成者による確認が必要。
