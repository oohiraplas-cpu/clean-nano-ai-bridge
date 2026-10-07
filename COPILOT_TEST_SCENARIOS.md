# Copilot から Bridge MCP を実行するテストシナリオ

## 【準備】

### 前提条件の確認

```bash
# Bridge の稼働状態を確認
curl -s -H "x-api-key: test" \
  -X POST "https://clean-nano-ai-bridge.azurewebsites.net/mcp" \
  -H "Content-Type: application/json" \
  -d '{"method":"health_check"}' | jq '.'

# 期待結果:
# {
#   "accepted": true,
#   "method": "health_check",
#   "result": {
#     "status": "ok",
#     "timestamp": "2026-10-07T..."
#   }
# }
```

---

## 【Scenario 1: Basic Connectivity】

**Copilot Instruction:**
```
"Bridge の稼働状態を確認して。変更禁止。"
```

**Expected Bridge Execution:**
```
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY from Azure]
Body: {
  "method": "health_check"
}
```

**Expected Response:**
```json
{
  "accepted": true,
  "method": "health_check",
  "result": {
    "status": "ok",
    "timestamp": "2026-10-07T08:37:50Z"
  }
}
```

**Success Criteria:**
- ✅ HTTP 200
- ✅ accepted = true
- ✅ status = "ok"
- ✅ Copilot receives and displays result

---

## 【Scenario 2: Tool Discovery】

**Copilot Instruction:**
```
"Bridge で登録済みのツール一覧を取得して。"
```

**Expected Bridge Execution:**
```
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Header: X-API-Key: [MCP_API_KEY]
Body: {
  "method": "tools/list"
}
```

**Expected Response:**
```json
{
  "accepted": true,
  "method": "tools/list",
  "result": [
    {
      "name": "health_check",
      "description": "Bridge 稼働状態確認"
    },
    {
      "name": "get_powerapps_app",
      "description": "Power Apps アプリ情報取得"
    },
    {
      "name": "get_powerapps_state",
      "description": "Power Apps 状態取得"
    },
    {
      "name": "get_powerapps_source",
      "description": "ソースコード情報取得"
    },
    {
      "name": "inspect_powerapps_target",
      "description": "対象アプリ検査"
    },
    {
      "name": "update_powerapps_app",
      "description": "ソースコード更新"
    },
    {
      "name": "save_powerapps_app",
      "description": "保存実行"
    },
    {
      "name": "publish_powerapps_app",
      "description": "公開実行"
    },
    ... (36個のツール)
  ]
}
```

**Success Criteria:**
- ✅ HTTP 200
- ✅ result 配列に36個のツール
- ✅ 各ツール名と説明を Copilot が表示

---

## 【Scenario 3: Power Apps State Inspection】

**Copilot Instruction:**
```
"CN_AI依頼台帳の対象アプリ情報と現在の状態を取得して。"
```

**Step 3.1: Inspect Target**
```
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Body: {
  "method": "inspect_powerapps_target",
  "params": {}
}
```

**Expected Response:**
```json
{
  "accepted": true,
  "method": "inspect_powerapps_target",
  "result": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b",
    "appName": "CN_AI依頼台帳",
    "environment": "Default-abc123...",
    "provider": "PowerApps",
    "timestamp": "2026-10-07T08:37:50Z"
  }
}
```

**Step 3.2: Get State**
```
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Body: {
  "method": "get_powerapps_state",
  "params": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b"
  }
}
```

**Expected Response:**
```json
{
  "accepted": true,
  "method": "get_powerapps_state",
  "result": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b",
    "branch": "main",
    "canonicalBranch": "main",
    "sha": "abc123def456...",
    "environment": "Default-abc123...",
    "status": "ok",
    "timestamp": "2026-10-07T08:37:50Z",
    "verified": true
  }
}
```

**Step 3.3: Get Source**
```
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Body: {
  "method": "get_powerapps_source",
  "params": {
    "appId": "app-8a2c9e4d-5f1b-4c3a-9d2b-1e5c7a4f9d3b"
  }
}
```

**Expected Response:**
```json
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
    "sourceContent": "{ ... YAML ... }",
    "status": "ok",
    "timestamp": "2026-10-07T08:37:50Z"
  }
}
```

**Success Criteria:**
- ✅ All 3 methods execute successfully
- ✅ appId, branch, sha, environment all retrieved
- ✅ sourceState = "github_canonical"
- ✅ writable = true
- ✅ Copilot displays integrated summary

---

## 【Scenario 4: Fail-Closed Validation - Missing State】

**Copilot Instruction:**
```
"State が不足している場合の検証をテストして。"
```

**Expected Bridge Execution:**
```
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
Body: {
  "method": "update_powerapps_app",
  "params": {
    "relativePath": "test.pa.yaml",
    "content": "{}"
  }
}
```

**Expected Response:**
```json
{
  "accepted": false,
  "method": "update_powerapps_app",
  "error": "Missing required state fields",
  "details": {
    "missing": ["appId", "environment", "branch", "canonicalBranch", "sha", "correlationId"],
    "reason": "State Manager Enforcement requires all 6 fields before write operations"
  }
}
```

**HTTP Status:** 400

**Success Criteria:**
- ✅ HTTP 400 (fail-closed)
- ✅ accepted = false
- ✅ error message is clear
- ✅ missing fields listed
- ✅ Copilot receives rejection

---

## 【Scenario 5: Fail-Closed Validation - Invalid SHA】

**Copilot Instruction:**
```
"Invalid SHA フォーマットをテストして。"
```

**Expected Bridge Execution:**
```
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
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
```

**Expected Response:**
```json
{
  "accepted": false,
  "method": "update_powerapps_app",
  "error": "Invalid SHA format",
  "details": {
    "reason": "SHA must be 40-character hexadecimal",
    "provided": "invalid-sha-format",
    "expected_format": "40-char hex (0-9a-f)"
  }
}
```

**HTTP Status:** 400

**Success Criteria:**
- ✅ HTTP 400 (fail-closed)
- ✅ accepted = false
- ✅ Explains SHA requirement
- ✅ Copilot receives rejection

---

## 【Scenario 6: Fail-Closed Validation - Branch Mismatch】

**Copilot Instruction:**
```
"Branch が一致しない場合をテストして。"
```

**Expected Bridge Execution:**
```
POST https://clean-nano-ai-bridge.azurewebsites.net/mcp
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
```

**Expected Response:**
```json
{
  "accepted": false,
  "method": "update_powerapps_app",
  "error": "Branch mismatch - writes only allowed on canonical branch",
  "details": {
    "provided_branch": "feature/xyz",
    "canonical_branch": "main",
    "reason": "Writes must target canonical branch only"
  }
}
```

**HTTP Status:** 400

**Success Criteria:**
- ✅ HTTP 400 (fail-closed)
- ✅ accepted = false
- ✅ Enforces canonical branch requirement
- ✅ Copilot receives rejection

---

## 【Scenario 7: Write Operations (Future)】

**Not yet implemented in Copilot.**

Future integration points:
- `update_powerapps_app` — source code update
- `save_powerapps_app` — save execution
- `publish_powerapps_app` — publish execution (approvedByHuman: true required)
- `verify_save_result` — save verification
- `get_deployment_logs` — deployment log retrieval

---

## 【Complete Success Criteria】

| Scenario | Status | Details |
|----------|--------|---------|
| Scenario 1: Basic Connectivity | ✅ Ready | health_check returns OK |
| Scenario 2: Tool Discovery | ✅ Ready | tools/list returns 36 tools |
| Scenario 3: Power Apps Inspection | ✅ Ready | State and source retrieved |
| Scenario 4: Missing State | ✅ Ready | HTTP 400 enforcement |
| Scenario 5: Invalid SHA | ✅ Ready | HTTP 400 enforcement |
| Scenario 6: Branch Mismatch | ✅ Ready | HTTP 400 enforcement |
| Scenario 7: Write Operations | ⏳ Future | Copilot approval flow pending |

---

## 【Copilot Studio Integration Checklist】

- [ ] Custom Connector registered in Copilot Studio
- [ ] Scenario 1 test passed (health_check)
- [ ] Scenario 2 test passed (tools/list)
- [ ] Scenario 3 test passed (inspect + state + source)
- [ ] Scenario 4 test passed (Missing State → 400)
- [ ] Scenario 5 test passed (Invalid SHA → 400)
- [ ] Scenario 6 test passed (Branch Mismatch → 400)
- [ ] Copilot displays results correctly
- [ ] Error messages are clear and actionable
- [ ] All responses within 5 seconds (SLA)
- [ ] Audit logging captures all requests
- [ ] Ready for production deployment

