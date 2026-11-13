# 新規社員登録フロー設計（Forms → Power Automate → SharePoint「CN_社員台帳」）

状態: 設計のみ（DESIGN）。実環境（Forms・フロー・SharePoint）には何も作成・変更していない。
対象リスト: 既存の **CN_社員台帳**。リストの削除・改名・列の変更は行わない。

## 確認済み / 未確認

| 項目 | 状態 | 根拠 |
|---|---|---|
| 列の内部名 | 確認済み | `src/sharePointListWriter.js` の `CN_EMPLOYEE_LEDGER_FIELD_MAP`（2026-09-20 に実環境の「リストの設定」で確認済みと記載） |
| Bridge の登録ツール | 確認済み | `create_employee_ledger_entry` / `update_employee_ledger_entry`（`approvedByHuman:true` 必須） |
| Forms のフォーム ID・質問内容 | **未確認** | 本リポジトリにない |
| 既存の登録用フローの有無 | **未確認** | 実環境を読んでいない |
| `EmployeeID` 列の一意制約・インデックス | **未確認** | 実環境の列設定が必要 |
| 列の型（日付・選択肢） | **未確認** | 下記の対応表は文字列を前提にした案 |

## 列の対応（Forms の質問 → CN_社員台帳）

| Forms の質問（案） | 業務名 | SharePoint 内部名 | 備考 |
|---|---|---|---|
| 氏名 | name | `Title` | 必須 |
| 社員ID | employeeId | `EmployeeID` | 必須・重複不可（下記） |
| 所属 | department | `Department` | |
| 在籍状態 | employmentStatus | `EmploymentStatus` | 新規は固定値（初期値は運用で決める） |
| （フォームに出さない） | progressStatus | `ProgressStatus` | フロー側で初期値を設定 |
| 入社日 | hireDate | `HireDate` | `YYYY-MM-DD` |
| 備考 | remarks | `Remarks` | 任意 |

`Modified` / `Created` / `Author` / `Editor` は標準列のため書き込まない。

## フローの手順

1. トリガー: Forms「新しい応答が送信されるとき」。
2. 「応答の詳細を取得する」で各回答を取得する。
3. **入力検証**: 氏名・社員ID・入社日が空でないこと、入社日が日付として有効なこと。不正なら登録せず、送信者へ差し戻しを通知する（SharePoint には書かない）。
4. **重複確認**: 「項目の取得」で `EmployeeID eq '<社員ID>'` を検索する。1 件以上あれば登録せず、重複として通知する。
5. **承認**: 承認アクションで人事担当の承認を取る。承認前に SharePoint へ書かない。承認されなければ終了する。
6. 「項目の作成」で CN_社員台帳に 1 行追加する（上の対応表）。
7. 完了通知（Teams またはメール）に、作成された項目 ID を入れる。

### 重複の扱い
同時に 2 件送信されると、手順 4 の確認だけでは重複を防げない。`EmployeeID` 列を「一意」にする設定（インデックス付き）が確実だが、列の変更は実環境側の判断が要る。**未確認**のため、導入前に実環境で確認する。

## エラー時の扱い

| 事象 | 扱い |
|---|---|
| 検証エラー | 登録しない。送信者へ通知 |
| 重複 | 登録しない。担当者と送信者へ通知 |
| 承認却下・期限切れ | 登録しない。結果を通知 |
| SharePoint 呼び出し失敗 | 再試行ポリシーは最大 3 回まで。それ以上は失敗として担当者へ通知（同じ失敗を繰り返さない） |
| 一部だけ書かれた疑い | フローの実行履歴と項目 ID で確認し、手動で是正する |

## ロールバック
- フロー: オフにする、または以前のバージョンに戻す。
- 登録済みの項目: 削除はしない。`EmploymentStatus` または `Remarks` で無効を示して残す。

## Bridge との関係
- 登録の確定は、人間の承認の後に行う。Bridge の `create_employee_ledger_entry` も `approvedByHuman:true` が必須で、AI だけでは確定しない。
- ChatGPT 向けの読み取り専用の窓口（`/connector/mcp`）には、登録ツールを出さない。

## 導入前の検証（実環境）
1. テスト用の応答を 1 件送る → 承認 → 項目が 1 件だけできること。
2. 同じ社員 ID をもう一度送る → 登録されないこと。
3. 日付が不正・必須が空 → 登録されないこと。
4. 承認を却下 → 登録されないこと。
5. 実行履歴と項目を再取得して、値が対応表どおりであること。

実環境で確認するまで、導入済みとは扱わない。

## 追補: Entra ID の自動取得と社員との紐付け

### 確認済み（アプリのソース `powerapps/CN_AI依頼台帳/Source` より）
- アプリは、サインインしたユーザーの Entra オブジェクトIDを `User().EntraObjectId`（Power Fx 標準・追加課金なし）で取得し、`LookUp(CN_社員台帳, EntraObjectId = Text(User().EntraObjectId))` で社員を特定している（`S1_Home` / `S3_Register` / `S4_Summary` / `S5_Salary`）。
- `S1_Home` は、社員ID と Entra オブジェクトIDの両方が台帳と一致したときだけ勤怠を読み込む。不一致なら読み込まず、通知する。
- つまり「Entra ID の自動取得」と「照合」は**すでにある**。足りないのは、新規登録時に Entra オブジェクトIDを台帳へ**書き込む**部分。

### 確認済みの問題（コード上の事実）
1. **Bridge の `CN_EMPLOYEE_LEDGER_FIELD_MAP` に `EntraObjectId` がない。** `create_employee_ledger_entry` / `update_employee_ledger_entry` は、この列を書けない。
2. **画面ごとに列の指定が混在している。** `S1_Home` / `S4_Summary` / `S5_Salary` は `EmployeeID` / `Title` を使い、`S2_Calendar` / `S3_Register` は `社員ID` / `氏名` を使っている。どちらかが実環境の列名と合っていない可能性がある。
3. **管理者判定に、固定のメールアドレスの比較を使っている**（`S2_Calendar` / `S3_Register`）。社員台帳の紐付けとは別の仕組みで、異動・退職に追随しない。

### 紐付けの設計（案）
- フローの手順 6（項目の作成）の前に、Office 365 Users の「ユーザーの取得 (V2)」で、社員のメールアドレスから Entra オブジェクトID（`Id`）を取得する。このコネクタは標準コネクタで、追加ライセンスは不要と理解しているが、**テナントのライセンスで要確認**。
- 「Microsoft Entra ID」コネクタ（プレミアム）と Dataverse は使わない（追加課金を避ける）。
- 取得した `Id` を `EntraObjectId` 列へ書く。取得できない場合は、登録を止めて通知する（空のまま登録しない）。
- 同じ Entra オブジェクトIDが、すでに別の社員にある場合は登録しない（重複確認に追加）。

### 実環境で確認すること（未確認）
- `EntraObjectId` 列の内部名と型。
- 台帳で使う列名が、`EmployeeID` / `Title` か `社員ID` / `氏名` か。
- テナントのライセンスで、Office 365 Users コネクタが追加費用なしで使えること。

### 変更の順序（承認が必要な操作を含む）
1. 実環境で上の3点を確認する。
2. 確認した内部名を、`CN_EMPLOYEE_LEDGER_FIELD_MAP` に追加する（コード変更・テスト・PR）。
3. フローを作成する（Power Automate の画面での操作と承認が必要）。
4. アプリの列指定を統一する（PR。保存・公開は人間の承認が必要）。
