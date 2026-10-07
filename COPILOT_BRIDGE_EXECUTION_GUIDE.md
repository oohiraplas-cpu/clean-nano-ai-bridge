# Copilot から Bridge MCP を実行するガイド

## 前提条件

Copilot Studio 環境で以下が設定済みであること：

- **コネクタ名**: Clean Nano AI Bridge
- **エンドポイント**: https://clean-nano-ai-bridge.azurewebsites.net/mcp
- **認証**: API Key (X-API-Key ヘッダー)
- **API Key**: Azure App Settings の MCP_API_KEY 値

---

## Phase 1: 基本疎通確認

### テスト 1.1: health_check

```
【Copilot指示】
"Bridge の稼働状態を確認して。変更は禁止。"

【実行内容】
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "health_check"
}

【期待結果】
HTTP 200
{
  "accepted": true,
  "method": "health_check",
  "result": {
    "status": "ok",
    "timestamp": "2026-10-07T08:37:50Z"
  }
}

【成功判定】
✅ HTTP 200
✅ result.status = "ok"
✅ Timestamp 取得
```

### テスト 1.2: tools/list

```
【Copilot指示】
"Bridge で登録済みのツール一覧を取得して。"

【実行内容】
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "tools/list"
}

【期待結果】
HTTP 200
{
  "accepted": true,
  "method": "tools/list",
  "result": [
    {
      "name": "health_check",
      "description": "Bridge の稼働状態確認"
    },
    {
      "name": "get_powerapps_app",
      "description": "Power Apps アプリケーション情報取得"
    },
    ... (36個のツール)
  ]
}

【成功判定】
✅ HTTP 200
✅ result 配列に36個のツール
✅ health_check, get_powerapps_app, tools/list 確認
```

---

## Phase 2: Power Apps 状態取得

### テスト 2.1: inspect_powerapps_target

```
【Copilot指示】
"CN_AI依頼台帳の対象アプリ情報を取得して。"

【実行内容】
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "inspect_powerapps_target",
  "params": {}
}

【期待結果】
HTTP 200
{
  "accepted": true,
  "method": "inspect_powerapps_target",
  "result": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b",
    "appName": "CN_AI依頼台帳",
    "environment": "Default-<GUID>",
    "provider": "PowerApps"
  }
}

【成功判定】
✅ HTTP 200
✅ result.appId 取得
✅ result.environment 取得
✅ result.provider = "PowerApps"
```

### テスト 2.2: get_powerapps_state

```
【Copilot指示】
"CN_AI依頼台帳の現在の状態を取得して。"

【実行内容】
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "get_powerapps_state",
  "params": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b"
  }
}

【期待結果】
HTTP 200
{
  "accepted": true,
  "method": "get_powerapps_state",
  "result": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b",
    "branch": "main",
    "canonicalBranch": "main",
    "sha": "abc123def456...",
    "environment": "Default-<GUID>",
    "status": "ok",
    "timestamp": "2026-10-07T08:37:50Z",
    "verified": true
  }
}

【成功判定】
✅ HTTP 200
✅ result.sha 取得（40文字hex）
✅ result.branch = "main"
✅ result.canonicalBranch = "main"
✅ result.environment 確認
```

### テスト 2.3: get_powerapps_source

```
【Copilot指示】
"CN_AI依頼台帳のソースコード情報と Git リンクを取得して。"

【実行内容】
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "get_powerapps_source",
  "params": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b"
  }
}

【期待結果】
HTTP 200
{
  "accepted": true,
  "method": "get_powerapps_source",
  "result": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b",
    "provider": "GitHub",
    "repository": "clean-nano-ai-bridge",
    "branch": "main",
    "canonicalBranch": "main",
    "isCanonicalBranch": true,
    "sourceState": "github_canonical",
    "writable": true,
    "sourceContent": "{ ... YAML content ... }",
    "status": "ok",
    "timestamp": "2026-10-07T08:37:50Z"
  }
}

【成功判定】
✅ HTTP 200
✅ result.provider = "GitHub"
✅ result.branch = "main"
✅ result.canonicalBranch = "main"
✅ result.isCanonicalBranch = true
✅ result.sourceState = "github_canonical"
✅ result.writable = true
```

---

## Phase 3: Fail-Closed Validation

### テスト 3.1: Missing State

```
【Copilot指示】
"State が不足している場合の検証をテストして。"

【実行内容】
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "update_powerapps_app",
  "params": {
    "relativePath": "test.pa.yaml",
    "content": "{}"
  }
}

【期待結果】
HTTP 400
{
  "accepted": false,
  "method": "update_powerapps_app",
  "error": "Missing required state fields",
  "details": {
    "missing": ["appId", "environment", "branch", "canonicalBranch", "sha", "correlationId"]
  }
}

【成功判定】
✅ HTTP 400（fail-closed）
✅ error メッセージ表示
✅ missing フィールド一覧
```

### テスト 3.2: Invalid SHA Format

```
【Copilot指示】
"Invalid SHA フォーマットの検証をテストして。"

【実行内容】
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "update_powerapps_app",
  "params": {
    "appId": "app-123",
    "environment": "Default-456",
    "branch": "main",
    "canonicalBranch": "main",
    "sha": "invalid-sha-format",
    "correlationId": "req-12345",
    "relativePath": "test.pa.yaml",
    "content": "{}"
  }
}

【期待結果】
HTTP 400
{
  "accepted": false,
  "method": "update_powerapps_app",
  "error": "Invalid SHA format",
  "details": {
    "reason": "SHA must be 40-character hexadecimal",
    "provided": "invalid-sha-format",
    "expected": "/^[a-f0-9]{40}$/i"
  }
}

【成功判定】
✅ HTTP 400（fail-closed）
✅ error = "Invalid SHA format"
✅ 詳細な理由を表示
```

### テスト 3.3: Branch Mismatch

```
【Copilot指示】
"Branch が一致しない場合の検証をテストして。"

【実行内容】
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "update_powerapps_app",
  "params": {
    "appId": "app-123",
    "environment": "Default-456",
    "branch": "feature/xyz",
    "canonicalBranch": "main",
    "sha": "1234567890abcdef1234567890abcdef12345678",
    "correlationId": "req-12345",
    "relativePath": "test.pa.yaml",
    "content": "{}"
  }
}

【期待結果】
HTTP 400
{
  "accepted": false,
  "method": "update_powerapps_app",
  "error": "Branch mismatch - writes only allowed on canonical branch",
  "details": {
    "provided_branch": "feature/xyz",
    "canonical_branch": "main",
    "reason": "Must write to canonical branch only"
  }
}

【成功判定】
✅ HTTP 400（fail-closed）
✅ error = "Branch mismatch"
✅ 正本ブランチへの強制
```

---

## Phase 4: Write Operations（将来実装）

以下のメソッドは将来 Copilot で公開予定：

- `update_powerapps_app` — ソースコード更新
- `save_powerapps_app` — 保存実行
- `publish_powerapps_app` — 公開実行（承認必須）
- `verify_save_result` — 保存検証
- `get_deployment_logs` — デプロイログ取得

---

## 統合チェックリスト

### ✅ Phase 1: 基本疎通
- [ ] Copilot から health_check が実行できる
- [ ] Copilot から tools/list が実行できる
- [ ] HTTP 200 応答を確認

### ✅ Phase 2: 状態取得
- [ ] inspect_powerapps_target で appId, environment 取得
- [ ] get_powerapps_state で branch, sha 取得
- [ ] get_powerapps_source で GitHub リンク確認

### ✅ Phase 3: Fail-Closed Validation
- [ ] Missing State → HTTP 400
- [ ] Invalid SHA → HTTP 400
- [ ] Branch Mismatch → HTTP 400

### ✅ Phase 4: Write Operations（将来）
- [ ] update_powerapps_app 実装
- [ ] save_powerapps_app 実装
- [ ] publish_powerapps_app 実装
- [ ] Evidence 自動収集

---

## トラブルシューティング

### 接続失敗

```
エラー: Connection refused / 503 Service Unavailable

確認項目:
1. Azure App 稼働状態: https://portal.azure.com
2. Bridge health_check: curl -s -H "x-api-key: test" https://clean-nano-ai-bridge.azurewebsites.net/mcp -d '{"method":"health_check"}'
3. Copilot コネクタ設定: API Key を確認
```

### HTTP 401 Unauthorized

```
エラー: Unauthorized

原因: X-API-Key ヘッダーが正しくない

確認:
1. MCP_API_KEY が Azure App Settings に設定されているか
2. Copilot コネクタの Secret 値が一致しているか
```

### HTTP 400 Bad Request

```
エラー: Bad Request

原因: リクエストボディが不正

確認:
1. JSON フォーマット: { "method": "...", "params": {...} }
2. method が正しいか
3. params が必須項目を含むか
```

---

## 次のステップ

1. **Copilot Studio** で Custom Connector 登録
2. Phase 1 テスト実行（health_check, tools/list）
3. Phase 2 テスト実行（inspect_powerapps_target, get_powerapps_state, get_powerapps_source）
4. Phase 3 テスト実行（Fail-Closed validations）
5. Phase 4 実装開始（Update, Save, Publish）

