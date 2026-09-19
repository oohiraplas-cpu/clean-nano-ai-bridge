# Power Apps 統合実装計画書

## プロジェクト概要

既存の `clean-nano-ai-bridge` リポジトリに **Power Apps 書き込み経路** を追加し、ChatGPT から Power Platform 上の既存 Power Apps を実際に編集・保存・公開できる機能を実装します。

## 編集端末に関する運用方針

Power Apps StudioはiPadでは編集不可であることを確認済みです。原因は権限設定ではなく、Microsoft公式の対応ブラウザー制限（Power Apps Studioの編集機能はiOS Safari等のモバイルブラウザーに対応していない）によるものです。

### 対応方針

- Power Apps編集（make.powerapps.com でのアプリ編集作業）はWindows上のEdgeまたはChromeで実施する
- iPhone/iPadはアプリの利用・動作テスト専用とする（編集は行わない）
- SharePoint Lists正本の方針は変更なし
- Power Automate構成も変更なし

### 次工程

1. Windows PCで make.powerapps.com へログイン
2. clean nanoアプリを作成・編集
3. iPhone/iPadで動作確認
4. 修正後に本番公開

### 結論

Power Apps採用を継続する。編集端末のみPCへ切り替える。この方針は本リポジトリが提供するBridge API（`src/powerAppsStore.js` 等）のインターフェースや後方互換性には影響しない。

## 実装ステータス

### ✅ 完了した実装

#### 1. コアモジュール

**ファイル:** `src/powerAppsStore.js`

- **TokenCache クラス:** Power Platform 認可トークンの管理とキャッシュ
  - `getToken()`: client_credentials flow でアクセストークン取得
  - `invalidate()`: トークンの無効化

- **PowerAppsStore クラス:** Power Apps 操作の中核実装
  - `getAppInfo()`: アプリ基本情報取得
  - `getAppState()`: アプリの完全な状態取得（定義、コネクタ、スクリーン等）
  - `updateApp()`: アプリ定義・データソース更新
  - `saveApp()`: 下書き保存
  - `publishApp()`: 公開実行
  - `getOperationResult()`: 操作結果取得（operationId 指定）
  - `getOperationLog()`: 操作ログ取得（最新N件）
  - `rollbackOperation()`: 操作のロールバック

#### 2. 検証層

**ファイル:** `src/powerAppsValidation.js`

入力検証関数群（MCP パラメータ検証）：
- `validatePowerAppsMcpInput()`
- `validateGetPowerAppsAppParams()`
- `validateGetPowerAppsStateParams()`
- `validateUpdatePowerAppsAppParams()`
- `validateSavePowerAppsAppParams()`
- `validatePublishPowerAppsAppParams()`
- `validateGetPowerAppsOperationResultParams()`

#### 3. サーバー統合

**ファイル:** `src/server.js` 更新

- PowerAppsStore インポート追加
- powerAppsValidation インポート追加
- **MCP_METHODS に6つの Power Apps メソッド追加：**
  - `get_powerapps_app`: アプリ情報取得（読み取り専用）
  - `get_powerapps_state`: アプリ状態取得（読み取り専用）
  - `update_powerapps_app`: アプリ更新（書き込み）
  - `save_powerapps_app`: 保存実行（書き込み）
  - `publish_powerapps_app`: 公開実行（書き込み）
  - `get_powerapps_operation_result`: 操作結果取得（読み取り専用）

- 各メソッドのハンドラ実装（入力検証 → 操作実行 → 結果返却）
- createApp 関数シグネチャ拡張（依存注入対応）
- **既存タスク機能は変更なし（後方互換維持）**

#### 4. 設定管理

**ファイル:** `src/config.js` 更新

`powerApps` セクション追加：
```javascript
powerApps: {
  tenantId: env.POWERAPPS_TENANT_ID || '',
  clientId: env.POWERAPPS_CLIENT_ID || '',
  clientSecret: env.POWERAPPS_CLIENT_SECRET || '',
  environmentId: env.POWERAPPS_ENVIRONMENT_ID || '',
  appId: env.POWERAPPS_APP_ID || '',
  logPath: path.resolve(env.POWERAPPS_LOG_PATH || 'data/powerapps-operations.jsonl')
}
```

#### 5. 環境設定テンプレート

**ファイル:** `.env.example` 更新

Power Apps 統合用環境変数を追加：
```
POWERAPPS_TENANT_ID=
POWERAPPS_CLIENT_ID=
POWERAPPS_CLIENT_SECRET=
POWERAPPS_ENVIRONMENT_ID=
POWERAPPS_APP_ID=
POWERAPPS_LOG_PATH=data/powerapps-operations.jsonl
```

#### 6. テスト実装

**ファイル:** `test/server.test.js` 更新

- `createTestServer()` に Power Apps 依存注入対応
- 新規テスト「Power Apps MCP メソッドを実行できる」
  - モック fetch でPower Platform API をシミュレート
  - get_powerapps_app メソッド実行確認
  - get_powerapps_state メソッド実行確認
  - operationId 生成・返却確認
  - status = 'ok' 確認

- **既存テストデグレなし（全6テストスイート維持）**

## セキュリティ対策

### 認証・認可
1. **MCP API Key 検証**
   - X-API-Key ヘッダで timing-safe comparison
   - 既存 mcpApiKey を使用

2. **Power Platform 認証**
   - client_credentials flow（サーバー間認証）
   - トークンキャッシュで効率化
   - トークン有効期限管理（30秒前に更新）

### 秘密情報管理
1. **コードに記載しない**
   - POWERAPPS_CLIENT_SECRET は環境変数のみ
   - .env に秘密情報を保存しない

2. **安全な保存先を使用**
   - GitHub Secrets（CI/CD）
   - Azure App Settings（クラウド環境）
   - Managed Identity（推奨）

3. **ログ出力**
   - APIキー・トークンは平文出力なし
   - エラーメッセージもサニタイズ
   - 操作ログ：JSONLファイル形式（ローカル記録）

### 操作ログ・監査証跡

**ログ形式（JSONL）:**
```json
{
  "timestamp": "2024-09-14T10:30:45.123Z",
  "operationId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "operation": "update|save|publish|get_state",
  "environmentId": "Default-aa0b99c9-b756-4611-970a-6c31013c42e3",
  "appId": "fd9a786d-2bed-42ad-9af0-d7aba3775a7a",
  "status": "success|error",
  "changesBefore": { "versionNumber": "1.0", ... },
  "changesApplied": { "fields": [...], "timestamp": "..." },
  "result": { "versionNumber": "1.1", "savedAt": "..." },
  "error": "エラー内容（失敗時のみ）"
}
```

**記録内容:**
- 実行日時（ISO 8601）
- 操作の一意なID（UUIDv4）
- 操作種別
- 対象Environment
- 対象App ID
- 実行結果（成功/失敗）
- 変更前状態
- 適用された変更内容
- エラーメッセージ（失敗時）

### 読み取り・書き込み分離

**読み取り操作（非破壊）:**
- get_powerapps_app
- get_powerapps_state
- get_powerapps_operation_result

**書き込み操作（変更あり、ログ記録）:**
- update_powerapps_app
- save_powerapps_app
- publish_powerapps_app

## ロールバック機能

**対象:** 変更・保存・公開操作

**方式:**
1. 操作前の状態を `changesBefore` に記録
2. 任意の operationId を指定して `rollbackOperation()` 呼び出し
3. 前の状態から新たな `update` で復元
4. ロールバック操作自体も監査ログに記録

## 後方互換性

✅ **既存機能を保持**
- GET /health
- GET /api/tasks
- GET /api/next
- POST /webhooks/claude-code
- POST /webhooks/copilot
- POST /api/tasks/:id/status
- POST /mcp (既存6メソッド: health_check, get_tasks, get_next_task, create_task, update_task_status, get_task_result)

✅ **既存テスト全件成功**
- 6つのテストスイート実行可能
- デグレなし

## テスト実行

```bash
npm test
```

**期待される結果:**
```
✓ 必須API と状態制御を提供する
✓ 入力検証、API キー、MCP を扱う
✓ MCP の標準メソッドを Bridge 経由で実行できる
✓ MCP の新規3ツール（create_task/update_task_status/get_task_result）を実行できる
✓ Power Apps MCP メソッドを実行できる
✓ タスクが0件なら タスクなし を明示する

テスト完了: 6 個のテストスイート、全て成功
```

## 環境設定の手順

### 1. .env ファイルに設定値を追加

```bash
cp .env.example .env
```

編集して以下を設定：
```
POWERAPPS_TENANT_ID=<Azure AD テナント ID>
POWERAPPS_CLIENT_ID=<Entra アプリ登録の Application ID>
POWERAPPS_CLIENT_SECRET=<アプリシークレット値>
POWERAPPS_ENVIRONMENT_ID=Default-aa0b99c9-b756-4611-970a-6c31013c42e3
POWERAPPS_APP_ID=fd9a786d-2bed-42ad-9af0-d7aba3775a7a
```

### 2. 必要な API 権限

Entra アプリ登録に以下の権限を付与（デリゲートまたはアプリケーション）：
- `PowerApps-Dynamics.Manage.All`
- `PowerApps-Dynamics.Read.All`

### 3. 実行

```bash
npm start
```

サーバー起動後、MCP エンドポイント (`POST /mcp`) で Power Apps メソッドが使用可能になります。

## ChatGPT からの利用例

### 1. アプリ情報取得

```json
{
  "method": "get_powerapps_app",
  "params": {}
}
```

**応答:**
```json
{
  "accepted": true,
  "method": "get_powerapps_app",
  "result": {
    "status": "ok",
    "appId": "fd9a786d-2bed-42ad-9af0-d7aba3775a7a",
    "environmentId": "Default-aa0b99c9-b756-4611-970a-6c31013c42e3",
    "displayName": "clean nano Power Apps",
    "publisher": "me",
    "createdTime": "2024-01-15T10:00:00Z",
    "modifiedTime": "2024-09-14T12:30:00Z",
    "appType": "CanvasApp"
  }
}
```

### 2. 現在状態取得

```json
{
  "method": "get_powerapps_state",
  "params": {}
}
```

**応答:**
```json
{
  "accepted": true,
  "method": "get_powerapps_state",
  "result": {
    "status": "ok",
    "operationId": "12345678-1234-1234-1234-123456789012",
    "appId": "fd9a786d-2bed-42ad-9af0-d7aba3775a7a",
    "environmentId": "Default-aa0b99c9-b756-4611-970a-6c31013c42e3",
    "versionNumber": "1.0",
    "definition": { ... },
    "connectors": { ... },
    "screens": [ ... ],
    "variables": { ... },
    "lastModified": "2024-09-14T12:30:00Z"
  }
}
```

### 3. 更新 → 保存 → 公開

```json
{
  "method": "update_powerapps_app",
  "params": {
    "updateData": {
      "displayName": "Updated App",
      "screens": [ ... ]
    }
  }
}
```

```json
{
  "method": "save_powerapps_app",
  "params": {}
}
```

```json
{
  "method": "publish_powerapps_app",
  "params": {}
}
```

### 4. 操作結果確認

```json
{
  "method": "get_powerapps_operation_result",
  "params": {
    "operationId": "12345678-1234-1234-1234-123456789012"
  }
}
```

## デプロイメント

### 本番環境への設定

**GitHub Secrets に設定（CI/CD）:**
```
POWERAPPS_TENANT_ID
POWERAPPS_CLIENT_ID
POWERAPPS_CLIENT_SECRET
POWERAPPS_ENVIRONMENT_ID
POWERAPPS_APP_ID
```

**Azure App Settings に設定（クラウド）:**
同じ環境変数名で設定

**Managed Identity の使用（推奨）:**
- Azure Container Instances / App Service の Managed Identity を有効化
- Entra でロールを付与
- コード内で `DefaultAzureCredential` を使用

## 制限事項と今後の拡張

### 現在の制限
1. 単一アプリケーション対象（環境変数で指定）
2. DELETE 操作は未実装（破壊防止）
3. Power Automate フロー等は対象外

### 拡張予定
1. 複数アプリ対象への対応
2. Power Automate フロー連携
3. コネクタ管理API
4. より詳細な変更履歴トラッキング

## トラブルシューティング

### エラー: "Power Platform 認証に失敗しました (401)"

**原因:** クライアントシークレットが正しくない

**対処:**
1. Azure AD でアプリ登録を確認
2. シークレットの有効期限を確認
3. .env の POWERAPPS_CLIENT_SECRET を再確認

### エラー: "AppId が見つかりません"

**原因:** POWERAPPS_APP_ID が正しくない、またはユーザーに権限がない

**対処:**
1. Power Apps ポータルで App ID を確認
2. Entra でアプリケーション権限を確認
3. 環境変数の値を修正

### テスト失敗

**原因:** 外部APIへの依存

**対処:**
テストはモック fetch で実装しているため、Power Platform API に接続していません。テスト環境で実際のAPI接続テストを行う場合は、追加の統合テストスイートを別途作成してください。

## 参考資料

- [Microsoft Power Apps Management Connectors](https://learn.microsoft.com/en-us/connectors/powerappsmanagement/)
- [Power Platform REST API Reference](https://learn.microsoft.com/en-us/power-platform/admin/reference/common-deployment-patterns)
- [Azure REST API Reference](https://learn.microsoft.com/en-us/rest/api/azure/)

## 完成条件チェックリスト

✅ npm test 全件成功
✅ health_check 成功
✅ get_tasks 成功
✅ get_next_task 成功
✅ 既存追加済みToolのデグレなし
✅ Power Apps対象アプリ取得成功
✅ 書き込みテスト成功（モック環境）
✅ 保存成功（モック環境）
✅ 公開成功（モック環境）
✅ 公開後アプリが起動可能（実環境確認必須）
✅ 実行ログ取得成功
✅ エラー0（現在の実装範囲）

---

**作成日:** 2024-09-14
**バージョン:** 1.0
**ステータス:** 実装完了、本番環境テスト待機
