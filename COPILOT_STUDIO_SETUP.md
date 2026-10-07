# Copilot Studio で Bridge MCP Custom Connector を登録する手順

## 前提条件

- Copilot Studio にアクセス可能（Microsoft 365 統合ユーザー）
- Azure App Settings で `MCP_API_KEY` が設定済み
- Bridge API エンドポイント: https://clean-nano-ai-bridge.azurewebsites.net/mcp

---

## Step 1: Copilot Studio にアクセス

1. https://copilotstudio.microsoft.com にアクセス
2. Microsoft 365 アカウントでサインイン
3. 左ナビゲーションで **「拡張機能」** → **「接続」** を選択

---

## Step 2: Custom Connector を作成

### 2.1 新規接続を作成

1. **「接続」** タブで **「+ 新規接続」** をクリック
2. **「カスタムコネクタ」** を選択
3. コネクタ名を入力: `Clean Nano AI Bridge`

### 2.2 基本情報を設定

| 項目 | 値 |
|------|-----|
| **名前** | Clean Nano AI Bridge |
| **説明** | Power Apps・SharePoint・Git を統合管理する Bridge MCP サーバー |
| **ホスト** | clean-nano-ai-bridge.azurewebsites.net |

### 2.3 認証を設定

1. **「セキュリティ」** セクションで **「認証の種類」** を選択
2. **「API キー」** を選択
3. 以下を設定：

| 項目 | 値 |
|------|-----|
| **ヘッダー名** | X-API-Key |
| **Secret 参照** | MCP_API_KEY (Azure App Settings から) |

---

## Step 3: API エンドポイントを定義

### 3.1 POST /mcp エンドポイントを追加

1. **「操作」** セクションで **「+ 新規操作」** をクリック
2. 以下を設定：

| 項目 | 値 |
|------|-----|
| **操作 ID** | InvokeMcpBridge |
| **メソッド** | POST |
| **パス** | /mcp |
| **説明** | MCP Bridge メイン エントリポイント |

### 3.2 リクエスト本体を定義

**「リクエスト」** セクション：

```json
{
  "method": "string (required)",
  "params": {
    "type": "object",
    "properties": {
      "appId": { "type": "string" },
      "environment": { "type": "string" },
      "branch": { "type": "string" },
      "canonicalBranch": { "type": "string" },
      "sha": { "type": "string" },
      "correlationId": { "type": "string" },
      "relativePath": { "type": "string" },
      "content": { "type": "string" },
      "approvedByHuman": { "type": "boolean" }
    }
  }
}
```

### 3.3 レスポンスを定義

**「レスポンス」** セクション：

```json
{
  "accepted": "boolean",
  "method": "string",
  "result": {
    "type": "object",
    "description": "Method-specific result object"
  },
  "error": "string (optional)",
  "details": {
    "type": "object",
    "description": "Error details (if error present)"
  }
}
```

---

## Step 4: Dynamic Schema を有効化（オプション）

Copilot が実行時にメソッドを発見できるようにするため：

1. **「詳細設定」** で **「実行時にスキーマを取得」** を有効化
2. **「スキーマ取得エンドポイント」**: `/mcp?method=tools/list`

---

## Step 5: 接続をテスト

### 5.1 健全性チェック

Copilot Studio で新しい Power Automate フローを作成：

1. **「新規フロー」** → **「クラウドフロー」** → **「自動化したクラウドフロー」**
2. トリガーを設定（例：手動トリガー）
3. アクション **「Clean Nano AI Bridge」** を追加
4. 以下でテスト：

```
操作: InvokeMcpBridge
リクエスト:
{
  "method": "health_check"
}
```

**期待結果:**
```json
{
  "accepted": true,
  "method": "health_check",
  "result": {
    "status": "ok",
    "timestamp": "2026-10-07T..."
  }
}
```

### 5.2 ツール一覧取得テスト

```
操作: InvokeMcpBridge
リクエスト:
{
  "method": "tools/list"
}
```

**期待結果:**
```json
{
  "accepted": true,
  "method": "tools/list",
  "result": [
    { "name": "health_check", "description": "..." },
    { "name": "get_powerapps_app", "description": "..." },
    ... (36個のツール)
  ]
}
```

---

## Step 6: Copilot に統合

### 6.1 Bridge Knowledge を追加

Copilot Studio で新しいエージェント（アシスタント）を作成：

1. **「新規トピック」** → **「Bridge 操作」**
2. **「手順」** に以下を追加：

```
【システム指示】
このトピックでは、Clean Nano AI Bridge を使用して Power Apps、SharePoint、
Git、Power Automate 操作を実行します。

【利用可能なメソッド】
- health_check: Bridge の稼働状態確認
- tools/list: 登録済みツール一覧
- inspect_powerapps_target: 対象アプリ情報取得
- get_powerapps_state: アプリケーション状態取得
- get_powerapps_source: ソースコード情報取得
- update_powerapps_app: ソース更新（状態フィールド必須）
- save_powerapps_app: 保存実行
- publish_powerapps_app: 公開実行（承認必須）

【重要な制約】
1. 常に最新状態を取得してから変更を実行してください
2. branch = "main" であることを確認してください
3. canonicalBranch = "main" であることを確認してください
4. SHA フォーマット: 40文字の16進数
5. 削除・改名・新規作成は禁止
6. 公開・権限変更・実行には approvedByHuman: true が必須
```

### 6.2 トピック分岐を設定

**「質問」** タブで：

```
ユーザーが「状態を確認して」と言った場合:
1. inspect_powerapps_target を実行
2. get_powerapps_state を実行
3. get_powerapps_source を実行
結果を表示して確認を取る
```

---

## Step 7: 本番運用準備

### チェックリスト

- [ ] Custom Connector が登録済み
- [ ] API Key が Azure App Settings に設定済み
- [ ] health_check テスト成功
- [ ] tools/list テスト成功
- [ ] inspect_powerapps_target テスト成功
- [ ] get_powerapps_state テスト成功
- [ ] get_powerapps_source テスト成功
- [ ] Fail-Closed 検証テスト成功（Missing State → 400）
- [ ] Fail-Closed 検証テスト成功（Invalid SHA → 400）
- [ ] Fail-Closed 検証テスト成功（Branch Mismatch → 400）
- [ ] Copilot エージェント設定完了
- [ ] ユーザーへの利用ガイド作成

### 本番運用ステップ

1. **テストユーザー向け限定公開**
   - 内部ユーザーのみで 1 週間テスト

2. **フィードバック収集**
   - 操作性、エラーメッセージ、パフォーマンス

3. **最適化・改善**
   - エラーメッセージの改善
   - タイムアウト値の調整

4. **全社向け公開**
   - すべてのユーザーに提供開始
   - ドキュメント配布

---

## トラブルシューティング

### エラー: Authentication failed

```
原因: X-API-Key ヘッダーが正しくない

解決:
1. Azure Portal で MCP_API_KEY を確認
2. Copilot Studio の Custom Connector Settings で Secret を再入力
3. コネクタを再保存
```

### エラー: Timeout

```
原因: Bridge API が応答遅延

確認:
1. Azure App Service の CPU / メモリ使用率を確認
2. ネットワーク接続を確認
3. App Service の再起動を試す
```

### エラー: Unexpected response schema

```
原因: レスポンススキーマが定義と異なる

確認:
1. Bridge の /mcp エンドポイントが正常に動作しているか確認
2. health_check で状態を確認
3. Copilot Studio でスキーマを再定義
```

---

## 完成

これで Copilot から Bridge MCP を直接実行できます。

次のステップ:
1. Phase 1 テスト実行
2. Phase 2 テスト実行
3. Phase 3 Fail-Closed 検証
4. Phase 4 Write Operations 実装

