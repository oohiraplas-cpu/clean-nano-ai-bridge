# 未確定画面の構成（Draft PR #29）

| 画面 | 入口・用途 | 接続状態 |
| --- | --- | --- |
| S12_EquipmentOCR | 設備カレンダーからOCRへ | 読取プレビューへの導線のみ |
| S13_MyDataOCR | 本人登録からOCRへ | 読取プレビューへの導線のみ |
| S14_DateDocuments | 日付セルから領収書・明細 | 選択日を保持し、添付画面へ遷移 |
| S15_OperationsMonthly | 運営の月次経理 | 損益表と貸借対照表の下書き画面へ遷移。運営入口は未接続 |
| S16_OperationsHub | 運営管理の入口 | 自社情報と月次経理に遷移。管理者権限未確認のため一般メニュー未接続 |
| S17_CompanyInfoOCR | 自社情報・OCR | 読取プレビューへ遷移、保存不可 |
| S18_OcrReadPreview | OCRの元画像・抽出候補の確認 | OCRエンジン未接続、確定不可 |
| S19_OcrFinalPreview | 完成帳票・宛先の確認 | PDF/FAX無効 |
| S20_MonthlyPL | 月次損益表 | 実帳簿未接続、金額・出力なし |
| S21_MonthlyBS | 月次貸借対照表 | 期首残高・仕訳未接続、金額・出力なし |
| S22_ReceiptCapture | 選択日に写真/PDFを貼る | 日付表示のみ、添付・保存不可 |

画面ソースはPower Apps Studioで取り込んで操作・表示を確認する前のレビュー用です。既存の出勤登録動作は維持。保存・公開、外部送信、仕訳確定は実装していません。`scripts/build_ocr_review_screens.py` はS16〜S22の画面ソースを再生成します。
