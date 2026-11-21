# AppSheet CNKK（Gemini実装担当 / OZ Router管理）

## 経路の事実（先に）
- **AppSheet公式APIはデータ操作のみ**（Find/Add/Edit/Action呼出）。View・Action・Slice・Security Filter・Automation・列設定・画像などの**アプリ定義は公式APIで編集できない**。これらは「安全なブラウザ自動操作（Editor）」で行う。Enterprise/追加契約APIは使わない・前提にしない。
- 公式APIで行うのは: データ読取、テスト行へのAction実行、`RunAsUserEmailAddress` でのSecurity Filter確認（実アプリでの挙動は要実測）。
- Geminiは実装案(plan)を作る。**planは信頼しない**: Router側で再検証・リスク分類し、作成者は検証者にならない。

## Capability（Router `googleWorkspace` 経由、`appsheet.*` で自動選択）
| capability | 内容 | 経路 | Human Gate |
|---|---|---|---|
| appsheet.inspect | 定義の読取・Snapshot・(任意)データ件数 | Editor + 公式API | 不要 |
| appsheet.edit | 列: type/key/ref/required/Show_If/Valid_If/Editable_If 等 | Editor | 不要 |
| appsheet.view.update | 画面/View/フォーム/一覧/詳細、スマホ縦(`mobile`)、Action割当 | Editor | 不要 |
| appsheet.action.update | ボタン/Action（data_set_values等。削除・外部URLは作成不可） | Editor | 不要 |
| appsheet.image.update | 画像/アイコン配置（`GOOGLE_APPSHEET_ASSET_DIR`配下のpng/jpg/webp 2MBまで、sha256照合） | Editor | 不要 |
| appsheet.security.update | Slice / Security Filter | Editor | **常に必須**（権限変更） |
| appsheet.automation.update | Bot/通知/GAS呼出（GASは許可scriptIdのみ） | Editor | 外部宛通知は必須 |
| appsheet.save | 保存 + 再取得照合（これだけでは完了にしない） | Editor | 不要 |
| appsheet.verify | **独立Verifier** + Evidence bundle | 別セッション + 公式API | 不要 |
| appsheet.deploy | 社内デプロイ + デプロイ後再取得/スマホE2E | Editor | 外部公開・課金・権限拡大は必須 |
| appsheet.rollback | Snapshotへ復元 | Editor | 自分のchangeSet以外のSnapshotは必須 |
| appsheet.change | 1指示: plan→編集→保存→検証→デプロイ→デプロイ後検証 | 上記を順次 | plan内容で判定 |

## 完了条件（コードで強制）
変更前Snapshot → 編集 → 保存 → 再取得照合 → [独立Verifier] 再取得/想定外変更なし/スマホ縦(390x844)表示/Action動作(`CNAI_TEST_`行のみ)/Security Filter(RunAs)/公開範囲=社内 → Evidence bundle(sha256) → Evidence Gate → drift確認 → 社内デプロイ → **デプロイ後の再取得+スマホE2E** → PASSでのみ `COMPLETED`。
- 編集のみ/保存のみ → `verified:false`（PARTIAL）。テスト指定が無い領域は NOT_TESTED = FAIL（fail-closed）。
- Verifierは別オブジェクト・別ブラウザcontext。Executorと同一なら `INDEPENDENCE_VIOLATION`。
- デプロイ後検証に失敗したら自動でSnapshotへ復元・再デプロイし、成功とは報告しない。
- Human Gateは提案payload固定（`proposalHash`）。スマホ→Copilot窓口(`cnai_google_request`)は読取（inspect/verify）と**提案のみ**で、実行は認証付きresume経由。

## 本人操作（最後に1回）
1. 同一Workspaceアカウントで既存OAuth同意（`node scripts/google-consent-plan.js`）。
2. AppSheetに1回ログインし storageState を保存（`GOOGLE_APPSHEET_STORAGE_STATE`）。自動操作はログイン/同意画面で `AUTH_REQUIRED` として停止し、認証入力は行わない。
3. AppSheetの `GOOGLE_APPSHEET_APP_ID` / アクセスキー（環境変数のみ）。

## 未実装・未検証（正直に）
- **Editor recipe（実際のAppSheet Editor操作手順）は同梱していない**。画面構造が未確認のためセレクタを推測せず、`GOOGLE_APPSHEET_RECIPES` に実Editorで記録・検証したrecipeが無い限り `EDITOR_RECIPE_MISSING` で停止する。したがって**現時点で実AppSheetの編集・保存・デプロイは未実行・未検証**。
- 実AppSheetとの疎通、`RunAsUserEmailAddress`・Action呼出のAPI挙動、プラン上のAPI利用可否は未確認。
- 公開範囲(`readSharing`)・デプロイ状態の意味づけ（Prototype/Deployed）もrecipe側で確認が必要。
- Snapshot/changeSet/Evidence bundle/提案はプロセスメモリ保持（再起動で消える）。
- 実ブラウザ(Chromium)でのスマホ表示ランナーはローカルHTMLでのみ検証済み。
