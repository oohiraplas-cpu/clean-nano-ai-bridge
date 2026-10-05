# Copilot Studio MCP登録情報

## MCP Server登録値

### Server Name
```
CNAI Bridge（M365版）
```

### Description
```
clean nano の既存 Power Apps、SharePoint、Power Automate、Git、Azure を調査、変更、保存、公開、検証、監査するための MCP 実行基盤です。

ユーザーが「あれ作って」「追加して」「直して」「保存して」「公開して」「状態を確認して」など、clean nano の業務システムに関する実行を依頼した場合に使用します。

既存資産を優先し、Power Apps 変更前にはアプリ、環境、ブランチ、最新ソースを確認します。保存後および公開後には状態とソースを再取得し、要求機能と既存主要機能を検証します。

Power Apps本番公開、Power Automate実行、業務データ更新、権限変更、課金、削除、外部公開には人間承認が必須です。

未確認結果を完了として報告しません。
```

### Server URL
```
https://clean-nano-ai-bridge-c7evcxhtergad9b0.westus3-01.azurewebsites.net/mcp
```

### Authentication Type
```
API Key
```

### Header Name
```
X-API-Key
```

### Secret Reference
```
Azure App Settings: MCP_API_KEY
```

### Note on Secrets
```
Secret値は決してコンソール出力・ログ出力・表示されません。
実値を入力したら、その後は参照のみになります。
```

---

## 実装状況

### Build & Test

```
✅ ユニットテスト: 170/170 全成功
✅ MCP特化テスト: 140/140 全成功
✅ 既存ツール回帰: なし
✅ Secret非表示: 検証済み
✅ JSON-RPC 2.0: 完全対応
```

### ツール数

```
既存ツール: 28個
優先A機能: 4個（Phase 2）
優先B機能: 4個（Phase 3）
──────────────
合計: 36個
```

### ツール一覧

#### 読み取り専用（30個）
- health_check
- get_tasks, get_next_task, get_task_result
- get_powerapps_app, get_powerapps_state, get_powerapps_source, get_powerapps_operation_result
- get_sharepoint_list, get_sharepoint_columns
- validate_powerapps_change, verify_save_result
- verify_deployment, get_deployment_logs
- get_permissions
- get_bridge_capabilities
- check_dependencies
- compare_powerapps_with_git
- validate_powerapps_source
- get_sharepoint_list_schema
- list_registered_power_automate_flows
- get_power_automate_run_result
- inspect_powerapps_structure

#### 書込・実行（6個、一部承認必須）
- create_task, update_task_status
- update_powerapps_app, save_powerapps_app
- ensure_sharepoint_columns

#### 公開・実行・承認必須（6個）
- publish_powerapps_app （承認必須）
- run_power_automate_flow （承認必須）
- create_employee_ledger_entry （承認必須）
- update_employee_ledger_entry （承認必須）
- deploy_to_test
- rollback_deployment （承認必須）
- update_permissions （承認必須）

---

## セキュリティ確認項目

### 認証
- [x] API Key実装
- [x] timingSafeEqual検証（タイミング攻撃対策）
- [x] Bearer Token対応
- [x] Query string対応

### Secret管理
- [x] Secret値をコード内に記載なし
- [x] Secret値をログ出力しない
- [x] Secret値を Git に push しない
- [x] Azure App Settings管理
- [x] リクエスト/レスポンスに表示されない

### 権限制御
- [x] approvedByHuman必須項目の実装
- [x] 公開・実行・変更系の承認ゲート
- [x] 未承認での実行拒否

### 監査
- [x] correlationId実装（全リクエスト追跡）
- [x] operationId実装（操作単位の識別）
- [x] timestamp実装（ISO 8601）
- [x] verified フラグ（確認状態）
- [x] status フラグ（ok/warning/error）

### 既存資産保護
- [x] 既存28ツール名変更なし
- [x] 既存28ツール削除なし
- [x] 既存 POST /mcp エンドポイント維持
- [x] 既存入力スキーマ互換性維持

### 追加課金
- [x] Premium Connector 不要
- [x] AI Builder 不要
- [x] Dataverse 不要
- [x] 追加課金なし

---

## CNAI統合情報

### Knowledge File
```
CNAI_Bridge_M365_Knowledge.md
└─ Bridge役割
└─ 接続情報
└─ ツール一覧（36個）
└─ Power Apps標準工程
└─ 公開工程
└─ 承認ルール
└─ 禁止事項
└─ 完了条件
```

### Instructions File
```
CNAI_Bridge_M365_Instructions.md
└─ CNAI行動指示
└─ 指示別の対象特定・実行順序
└─ 優先順位（既存優先）
└─ 毎回の必須手順
└─ branch確認の重要性
└─ 更新後・公開後の確認要件
└─ 完了条件
└─ 禁止事項チェックリスト
```

---

## 登録後の動作確認

### テスト1: 疎通確認
```
CNAI: Bridgeの稼働状態を確認して。変更は禁止。

期待: health_check が実行される
返値: { status: 'ok' }
```

### テスト2: 読取確認
```
CNAI: CN_AI依頼台帳の現在情報と最新ソースを取得して。変更禁止。

期待: get_powerapps_app, get_powerapps_state, get_powerapps_source が実行される
返値: App情報, 状態, ソースが返される
```

### テスト3: 差分比較
```
CNAI: CN_AI依頼台帳のPower AppsとGit正本を比較して。

期待: compare_powerapps_with_git が実行される
返値: 差分状態（in_sync/diverged等）
```

### テスト4: 承認必須確認
```
CNAI: approvedByHuman なしで Power Apps を公開して。

期待: 実行を拒否される
返値: エラー（承認必須）
```

### テスト5: 能力確認
```
CNAI: Bridge の現在の能力情報を取得して。

期待: get_bridge_capabilities が実行される
返値: Version, ツール数, 制約情報を返す
```

---

## トラブルシューティング

### 接続失敗
→ MCP Server URL を確認
→ X-API-Key ヘッダーを確認
→ 認証コネクタが接続済みか確認

### Tool Not Found
→ tool 名のタイプを確認
→ 36個のツール全て登録されているか確認

### Secret不足
→ Azure App Settings で MCP_API_KEY が設定されているか確認
→ Copilot Studio のコネクタ設定で Secret が入力されているか確認

### 200 OK だが結果が empty
→ read_conversation してログを確認
→ Bridge health_check で Bridge 側のエラーを確認

---

## 次のステップ（本番運用）

### 初回公開前チェックリスト
- [ ] Copilot Studio で MCP コネクタが接続済み
- [ ] テスト1〜5の全テスト合格
- [ ] Power Apps 実装チーム承認
- [ ] 監査ログ記録が正常
- [ ] Rollback 計画が策定済み

### 本番運用開始
1. CNAI に Knowledge/Instructions 適用
2. テストユーザー向けに限定公開
3. ユーザーフィードバック収集
4. 問題修正・最適化
5. 全社向け本番公開

