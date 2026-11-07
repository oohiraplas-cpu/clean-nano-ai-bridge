# MCP 認証鍵のローテーション手順（実値は記載しない）

対象: `/mcp`、`/mcp/operations`（`/connector/mcp` は別鍵 `CONNECTOR_API_KEY` で、この手順の対象外）。

## 仕組み
- 鍵は `CN_MCP_API_KEY` を最優先で読む。未設定のときだけ後方互換の `MCP_API_KEY` を読む（`resolveMcpApiKey`）。
- 両方とも未設定のときは `/mcp` 系が 503 で拒否する（fail closed）。鍵の値・有無はレスポンスに出さない。
- 起動前チェック（`productionReadiness`）は、どちらかの変数名が設定されていれば通す。値は表示しない。

## 手順（承認後に人間が実施）
1. 新しい鍵を生成し、App Service の `CN_MCP_API_KEY` に設定する（値は記録しない）。
2. `MCP_API_KEY` が設定されている場合は、同時に削除する。`CN_MCP_API_KEY` が優先されるため、残しても新鍵が使われるが、混乱防止のため削除する。
3. 再起動後、`authentication_check` で `activeVariable` が `CN_MCP_API_KEY` になっていることを確認する。
4. 利用側（Claude.ai カスタムコネクタ、Copilot Studio の接続）へ新鍵を登録し、`health_check` が通ることを確認する。
5. 旧鍵の利用が無いことを確認してから、旧鍵の失効を判断する（失効自体は承認が必要な作業）。

## 注意
- 旧鍵が過去のチャットや画面に平文で出た記録がある場合は、速やかに失効・再発行を検討する。
- 鍵を Git、ログ、URL のクエリ、監査データに書かない。
