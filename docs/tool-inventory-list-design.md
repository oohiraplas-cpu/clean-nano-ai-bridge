# 在庫・工具管理 SharePointリスト 列設計案

対象画面: `powerapps/CN_AI依頼台帳/Source/S20_ToolInventory.pa.yaml`
状態: **設計案(未作成)**。リストの作成・Power Appsへのデータ接続は人間が行う。作成後に列名を教えてもらえれば、画面側を差し替える。

## リスト名

`CN_在庫工具台帳`(既存の `CN_社員台帳` などの命名に合わせる)

## 列

| 表示名 | 内部名(作成時に付ける) | 型 | 必須 | 備考 |
|---|---|---|---|---|
| 工具名 | `Title`(既定の列を改名) | 1行テキスト | ○ | 画面の `Name` |
| 分類 | `ToolCategory` | 選択肢 | | 工具 / 消耗品 / 計測器 / 安全用品 / その他 |
| 在庫数 | `StockQty` | 数値(整数、最小0) | ○ | 既定値0。画面の＋/－が更新する列 |
| 保管場所 | `StorageLocation` | 1行テキスト | | 倉庫 / 車両など。運用が固まれば選択肢にする |
| 発注点 | `ReorderLevel` | 数値(整数、最小0) | | 在庫数がこれ以下なら警告表示に使う |
| 備考 | `ToolNote` | 複数行テキスト | | |

## 作成時の注意

- SharePointの**内部名は作成時の名前で固定**される。日本語で作ると `_x5728__x5eab_` のような文字列になるため、先に上表の英字内部名で作成し、その後に表示名を日本語へ変更する。
- 「必須」は `Title` と `StockQty` のみ。それ以外は空でも登録できるようにする(現場での登録を止めない)。
- 工具の削除はリスト側では行わず、運用上は在庫0のまま残すことを推奨(既存データの削除をしない方針に合わせる)。

## 画面の項目との対応

| 現在の `colTools` 項目 | リスト列 |
|---|---|
| `Name` | `Title` |
| `Category` | `ToolCategory` |
| `Stock` | `StockQty` |
| `Location` | `StorageLocation` |
| `Note` | `ToolNote` |
| `ToolID` | SharePointの `ID` を使用(自前採番は不要) |

## 接続後に画面側で行う置換

- `OnVisible`: `ClearCollect(colTools, ...)` のサンプルを `ClearCollect(colTools, CN_在庫工具台帳)` に変更
- ＋/－ボタン: `Patch(colTools, ...)` を `Patch(CN_在庫工具台帳, ThisItem, {StockQty: ...})` に変更(在庫数のマイナス防止は維持)
- 追加ボタン: `Collect(colTools, ...)` を `Patch(CN_在庫工具台帳, Defaults(CN_在庫工具台帳), {...})` に変更
- 保存失敗時は `Errors()` を確認して `Notify` する

## 任意: 履歴リスト(必要になったら)

誰がいつ在庫を増減したかを残す場合は `CN_在庫履歴台帳` を別に作る(工具ID・増減数・操作者・日時)。初回は不要。
