# Copilot Studio 貼り付けシート（CNAI Bridge）

Copilot Studio の画面に、上から順にコピーして貼り付けるための資料です。秘密値（API キー）は含みません。

## 1. MCP サーバーの登録（ツール → 追加 → MCP サーバー）

| 項目 | 入力値 |
| --- | --- |
| サーバー名 | `CNAI Bridge（M365版）` |
| サーバー URL | `https://clean-nano-ai-bridge-c7evcxhtergad9b0.westus3-01.azurewebsites.net/mcp` |
| 認証の種類 | API キー |
| ヘッダー名 | `X-API-Key` |
| API キーの値 | Azure App Service の構成 `MCP_API_KEY` と同じ値（画面にだけ入力。チャットやコードには書かない） |

説明欄には、`COPILOT_STUDIO_REGISTRATION.md` の「Description」の文面を貼り付けます。

## 2. エージェントの指示

`docs/copilot-studio-instructions-short.txt` の全文（約 4,200 文字）を、エージェントの「指示」欄に貼り付けます。
Copilot Studio の指示欄には文字数の上限（8,000 文字）があります。`CNAI_Bridge_M365_Instructions.md` は約 31,000 文字あり、そのままでは貼れないため、短縮版を用意しました。

## 3. 疎通テスト（変更を伴わないものだけ）

テスト画面に、次を順に入力します。

1. `Bridge の稼働状態を確認して。変更は禁止。`
   - 期待結果：health_check が `ok` を返す
2. `Bridge で登録済みのツール一覧を取得して。`
   - 期待結果：公開ツール 24 個が見える

## 4. 公開

テストがすべて成功してから、エージェントを公開します。公開は人間の承認事項です。

## うまくいかないとき

| 症状 | 確認すること |
| --- | --- |
| 401 / 認証エラー | API キーの値、ヘッダー名 `X-API-Key` |
| 接続できない | URL の綴り、Azure App Service の稼働状況 |
| ツールが 24 個に満たない | 接続を再保存して、ツール一覧を再取得 |
