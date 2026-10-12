# ご意見ボックス 最小変更案（未適用）

対象: CN_AI依頼台帳 / S7_Settings.pa.yaml
状態: DESIGN ONLY / 本番保存・公開禁止

## 読み取り証跡
- S7_Settings 既存 SHA: e82d8e2a10332771685e3d4a76fcde05feeeb820
- MainScreen1 既存 SHA: d316f13b18a7a64d989e9a790a51c256e3b527e6
- 既存 MainScreen1 の Form1 は CN_AI依頼台帳に SubmitForm(Form1) する。
- SharePoint CN_AI依頼台帳: RequestContent(複数行), Requester(Person), RequestCategory(Choice: その他を含む), AIRequestStatus(Choice: 受付を含む)。
- CN_ご意見台帳 は既存Bridgeから名前検索で見つからなかった。全サイト不存在の証明ではない。

## UI差分案
1. S7_Settings にボタン S7_Feedback（Text=ご意見ボックス、緑色/高さ52/左右16）を追加。既存の S7_Src と下部ナビに重ならないよう縦配置を調整。
2. 既存の入力画面・フォームを再利用できるか実ソースとデータ接続を追加確認。新規画面を作らずに済む場合は既存フォームを新規入力モードで開く。
3. 投稿入力は本文必須、投稿者はログインユーザー固定、重複送信防止、成功・失敗通知、戻る導線を付与。
4. 保存候補: RequestContent に本文、RequestCategory に「その他」、AIRequestStatus に「受付」。ただし既存AI処理の誤起動防止が実証されるまで Patch/SubmitForm の実装は HOLD。

## 停止条件
- 既存フローが「その他」区分を実行する可能性、投稿者Person型の解決未確認、必須列/データソース接続未確認。
- GitHubコードとPower Apps保存済み実ソースの一致未確認。
- バックアップ実行・復元可能性未確認、App Checker重大0未確認、遷移/保存テスト未実施。
- mainへのマージ、Power Apps更新・保存・公開、SharePoint変更、権限拡大は禁止。

## 次の検証
- CN_AI依頼台帳を参照するフローのトリガー/条件を読み取り、意見投稿がAI実行されないことを確認。
- 既存Form1のNewForm/OnSuccess/OnFailureと必須列、ユーザー権限を検証。
- Power Apps実ソースのバックアップとApp Checkerを取得し、隔離されたテストで遷移・保存・重複送信を確認。
