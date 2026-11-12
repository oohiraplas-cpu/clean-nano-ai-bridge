# Copilot Studio 引渡し仕様: CNAI Router READ-only 入口

Microsoft Copilot / Copilot Studio から `cnai_status` と `cnai_route_request` を呼ぶための接続仕様です。秘密値は含みません。

## 接続

| 項目 | 値 |
|---|---|
| 登録方式 | Copilot Studio「ツールを追加 → Model Context Protocol」(カスタムコネクタ/Premium 不使用) |
| Endpoint | `https://clean-nano-ai-bridge-c7evcxhtergad9b0.westus3-01.azurewebsites.net/connector/mcp`(運用 Runbook 記載の本番ホスト) |
| HTTP method | `POST`(JSON-RPC 2.0)。`GET` は 405 |
| 認証方式 | API キー。ヘッダー `x-api-key`(または `Authorization: Bearer`、クエリ `api_key`) |
| 必要 Header | `x-api-key`, `Content-Type: application/json` |
| キーの保管場所 | Azure App Service の App Settings `CONNECTOR_API_KEY`(既存)。Copilot Studio 側は接続の認証欄に入力(Git・ログ・本書には書かない) |
| キー未設定時 | エンドポイント自体が 404(fail-closed) |
| 認証なし / 不正キー | 401 `{"error":"認証に失敗しました"}` |

`/mcp`(`MCP_API_KEY`)とは別キーで、相互に使えません。この入口から書込み系ツールは呼べません。

## tools/list

`cnai_status`, `cnai_route_request` のほか、既存の読み取り専用 5 ツール(`health_check`, `resolve_app_target`, `get_powerapps_app`, `get_powerapps_state`, `get_powerapps_source`)。

## cnai_status

入力: なし(`{}`)。

```json
{
  "status": "ok",
  "router": { "reachable": true, "routes": ["..."], "copilotReadOnlyTargets": ["sharepoint", "operationsMcp", "localCode"] },
  "bridgeMax": { "reachable": true },
  "version": "1.1.0",
  "deploymentSha": "<DEPLOYMENT_SHA または null>",
  "verificationStatus": "VERIFIED | UNVERIFIED"
}
```

`deploymentSha` が null(App Settings の `DEPLOYMENT_SHA` 未設定)の場合は `UNVERIFIED` を返します。

## cnai_route_request 入力 schema

```json
{
  "type": "object",
  "required": ["requestId", "operation", "target"],
  "additionalProperties": false,
  "properties": {
    "requestId": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
    "correlationId": { "type": "string", "pattern": "^[A-Za-z0-9._:-]{1,128}$" },
    "operation": { "enum": ["read", "list", "status"] },
    "target": { "enum": ["sharepoint", "operationsMcp", "localCode"] },
    "payload": { "type": "object" }
  }
}
```

- `target=sharepoint`: `payload = { siteId?, listId | listName, top? }`(`operation=list` は `{ siteId?, searchTerm?, top? }`)。列名・列型は実リストから取得します(固定値なし)。
- `target=operationsMcp`: `payload = { tool, arguments? }`。`tool` は `health_check` / `list_sharepoint_lists` / `get_sharepoint_list_schema` のみ。
- 同じ `requestId` の再送は再実行されず、同じ `auditId` と `duplicate:true` を返します(冪等)。
- 書込み系 operation、`windowsExecutor` 等の他 target、`riskLevel` などの未定義プロパティは、Router に渡る前に `REJECTED` になります。

## cnai_route_request 応答 schema

```json
{
  "status": "COMPLETED | PARTIAL | BLOCKED | FAILED | REJECTED",
  "verificationStatus": "VERIFIED | UNVERIFIED | FAILED",
  "selectedRoute": "string|null",
  "requestId": "string|null",
  "correlationId": "string|null",
  "auditId": "string|null",
  "executionStatus": "string|null",
  "result": {},
  "readBackResult": { "performed": true, "matched": true, "firstReadSha256": "...", "secondReadSha256": "...", "count": 0 },
  "errorCode": "string|null",
  "errorSummary": "string|null"
}
```

`VERIFIED` になるのは、SharePoint を 2 回読み、内容のハッシュが一致した場合だけです。不一致は `PARTIAL` / `UNVERIFIED` + `READ_BACK_MISMATCH` です。

## error schema(errorCode)

| errorCode | 意味 / 切り分け |
|---|---|
| `INVALID_REQUEST` | 入力不正(requestId 形式、payload 不足など) |
| `READ_ONLY_VIOLATION` | 読み取り専用の範囲外(operation / target / tool) |
| `UNAUTHORIZED` | 上流 401(認証) |
| `FORBIDDEN` | 上流 403(権限・access policy) |
| `NOT_FOUND` | 上流 404(list / route / endpoint の差分) |
| `UPSTREAM_TIMEOUT` | 上流タイムアウト |
| `UPSTREAM_ERROR` | その他の上流エラー(メッセージは秘密値マスク済み) |
| `READ_BACK_MISMATCH` | 再読込が一致しない(未確認) |

HTTP コードだけで原因を断定せず、`deploymentSha`・App Settings・ログで確認してください。

## READ-only テスト入力と期待

1. `cnai_status` `{}` → `status:"ok"`, `deploymentSha` が非 null なら `verificationStatus:"VERIFIED"`。
2. `cnai_route_request`
   `{"requestId":"t-001","operation":"read","target":"sharepoint","payload":{"listName":"<既存リスト名>","top":5}}`
   → `status:"COMPLETED"`, `verificationStatus:"VERIFIED"`, `selectedRoute:"sharepoint"`, `readBackResult.matched:true`, `auditId` あり。
3. 同じ `requestId` を再送 → `duplicate:true`、`auditId` が 1 と同一。
4. `operation:"update"` → `status:"REJECTED"`, `errorCode:"READ_ONLY_VIOLATION"`。

## Copilot Studio 登録手順(人間操作)

1. 対象エージェント → ツール → ツールを追加 → Model Context Protocol。
2. サーバー URL に上記 Endpoint、認証を「API キー」(ヘッダー名 `x-api-key`)にし、`CONNECTOR_API_KEY` の値を入力。
3. `cnai_status` と `cnai_route_request` を有効化し、上記テスト入力 1 を実行して結果を確認。

## 課金

追加課金なし(既存 App Service・既存 SharePoint・MCP 接続のみ。Premium コネクタ・新規リソースなし)。

## 未確認(本番反映後に確認)

Azure 本番での `health` / `initialize` / `tools/list` / `cnai_status` / `cnai_route_request` と、実 SharePoint リストでの read-back は、本書作成時点では未実施です(`PRODUCTION_UNVERIFIED`)。
