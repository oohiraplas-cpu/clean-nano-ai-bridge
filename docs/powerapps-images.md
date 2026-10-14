# Power Apps画像の追加・編集

既存アプリの画面ソースへ画像コントロールを追加・編集し、既存の保存・公開経路へ渡します。新規アプリや接続を作成しません。

## ツール

- `get_powerapps_media_asset`: `operation` は `get` / `export` / `list`。Gitに存在する画像をBase64のまま読み取ります。`list` は指定された候補パス（最大50個）だけを確認します。アプリ内の全メディアを探索する機能ではありません。
- `update_powerapps_image`: `operation` は `add` / `edit`。対象は既存画面の `.pa.yaml` にある `Image@2.2.3` コントロールです。追加時は画像が必須、編集時は画像差し替え・表示設定のみの変更が可能です。編集は既存のImageコントロールだけを対象にします。

画像はPNG/JPEG/GIF/WebP、1MiBまでです。標準Base64または対応する `data:<contentType>;base64,...` を指定します。形式のヘッダーを検査しますが、画像を完全にデコードして破損の有無を判定する機能はありません。SVGは対象外です。

画像は画面の `Image` プロパティへdata URIとして埋め込みます。Power Appsのメディアライブラリに別ファイルを登録する機能ではありません。画像の内容自体の加工（切抜き・合成等）は別途行い、その結果を差し替えてください。

## 実行手順

1. `health_check` → `resolve_app_target` → `get_powerapps_app` → `get_powerapps_state`。
2. 同じ `correlationId` と `stateSessionId` で `get_powerapps_source` を呼び、対象画面を取得。
3. 返却された `path` / `branch` / `stateContext` / `stateSessionId` をそのまま `update_powerapps_image` に指定。
4. Git変更後は状態とソースを再取得し、静的検査・差分確認を行う。
5. 新しい状態コンテキストで `save_powerapps_app` を実行し、状態とソースを再取得・照合。
6. 人間の公開指示を確認し、既存 `publish_powerapps_app` のセッション・SHA検証を通して公開。公開後の状態・ソース・画面表示を再確認。

追加例（状態情報とBase64は実取得値へ置き換える）：

```json
{
  "operation": "add",
  "relativePath": "powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml",
  "screenName": "S1_Home",
  "controlName": "CompanyLogo",
  "base64Content": "<PNGのBase64>",
  "contentType": "image/png",
  "properties": {
    "X": 16, "Y": 16, "Width": 120, "Height": 64,
    "ImagePosition": "Fit", "AccessibleLabel": "会社ロゴ"
  },
  "branch": "<取得したbranch>",
  "stateContext": "<取得したオブジェクト>",
  "stateSessionId": "<取得したセッションID>"
}
```

登録済みセッション、対象アプリ・環境、正本commit、対象ファイルのblob SHAを検証し、書込み直前のblob SHAも照合します。古い状態・別セッション・別branchでの画像編集は設定にかかわらず拒否します。Git更新後はソースを再取得し内容を照合します。応答の `gitVerified:true` はGitの照合だけを示し、`saved:false` / `published:false` はPower Appsの保存・公開を別途行う必要があることを示します。

既存SolutionのGit同期が成立しない場合、画面の実反映は未確認です。同期スキップを保存・公開成功と扱わないでください。Power Apps Studioでの表示確認はローカルの自動テストに含まれません。

## 運用への反映

Bridgeのコードを既存デプロイ経路で配備し、ライブ `tools/list` に上記2ツールがあることを確認してください。ChatGPT/Copilotの既存接続のツール一覧も更新が必要です。この変更だけで現在の接続のツール登録や本番配備が完了するわけではありません。

復旧は変更コミットをrevertして既存経路で再配備します。画像変更はGit履歴に残るため、対象画面の変更だけをrevertできます。
