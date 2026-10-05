# CNAI Bridge（M365版）Knowledge

## 1. Bridgeの役割

clean nano Bridge は、Copilot Studio の CNAI エージェントから Power Apps、SharePoint、Power Automate、Git、Azure を安全に操作するための実行基盤です。

**CNAIの立場**: 司令塔・調査官。ユーザーの指示から対象と必要な変更を特定し、Bridge に実行を指令します。

**Bridge の立場**: 実行基盤。状態取得→対象特定→変更→検証→保存→公開→監査まで安全に実施します。

---

## 2. 接続情報

### コネクタ登録情報

```
コネクタ名: CNAI Bridge（M365版）
MCP Server: https://clean-nano-ai-bridge-c7evcxhtergad9b0.westus3-01.azurewebsites.net/mcp
認証方式: API Key
ヘッダー: X-API-Key
Secret: Azure App Settings の MCP_API_KEY
```

### セキュリティ

- Secret値は参照・表示・出力しない ✅
- タイミング攻撃対策実装済み ✅
- JSON-RPC 2.0 対応 ✅
- 人間承認制御実装済み ✅

---

## 3. 公開MCPツール一覧（36個）

### 既存ツール（28個）

#### タスク管理（6個）
- **health_check**: Bridge稼働状態確認（読取）
- **get_tasks**: タスク一覧取得（読取）
- **get_next_task**: 次実行可能タスク取得（読取）
- **create_task**: タスク作成（書込）
- **update_task_status**: タスク状態更新（書込）
- **get_task_result**: タスク結果取得（読取）

#### Power Apps操作（7個）
- **get_powerapps_app**: Power Appsアプリ情報取得（読取）
- **get_powerapps_state**: Power Appsアプリ状態取得（読取）
- **get_powerapps_source**: Power Appsソースファイル取得（読取）
- **update_powerapps_app**: Power Appsアプリ更新（書込）
- **save_powerapps_app**: Power Appsアプリ保存（書込）
- **publish_powerapps_app**: Power Appsアプリ公開（書込・承認必須）
- **get_powerapps_operation_result**: 操作結果取得（読取）

#### SharePoint操作（3個）
- **get_sharepoint_list**: SharePoint List項目取得（読取）
- **get_sharepoint_columns**: SharePoint List列定義取得（読取）
- **ensure_sharepoint_columns**: SharePoint List列追加・検証（書込）

#### Power Automate・社員台帳（4個）
- **run_power_automate_flow**: Power Automateフロー実行（実行・承認必須）
- **create_employee_ledger_entry**: 社員台帳項目作成（書込・承認必須）
- **update_employee_ledger_entry**: 社員台帳項目更新（書込・承認必須）

#### デプロイ・権限（8個）
- **validate_powerapps_change**: Power Apps変更検証（読取）
- **run_powerapps_tests**: Power Appsテスト実行（実行）
- **verify_save_result**: 保存結果検証（読取）
- **deploy_to_test**: テスト環境へデプロイ（実行）
- **verify_deployment**: デプロイ検証（読取）
- **get_deployment_logs**: デプロイログ取得（読取）
- **rollback_deployment**: デプロイロールバック（実行・承認必須）
- **get_permissions**: 権限取得（読取）
- **update_permissions**: 権限更新（書込・承認必須）

### 優先A機能（4個）

- **get_bridge_capabilities**: Bridge能力情報取得（読取）
  - Version、MCP仕様、ツール一覧、制約情報
  
- **check_dependencies**: 依存先health確認（読取）
  - Power Apps、SharePoint、Power Automate、Git、Azure の状態確認
  
- **compare_powerapps_with_git**: Power Apps ↔ Git差分比較（読取）
  - 一致、新しい、競合等の状態判定
  
- **validate_powerapps_source**: ソース検査（読取）
  - 構文、Secret混入、ファイルサイズ

### 優先B機能（4個）

- **get_sharepoint_list_schema**: SharePoint List スキーマ取得（読取）
  - 列定義、型、必須、一意制約等
  
- **list_registered_power_automate_flows**: 登録済みフロー一覧（読取）
  - フロー名、用途、入力定義、承認要否
  - トリガーURLとSAS値は非返却
  
- **get_power_automate_run_result**: フロー実行結果取得（読取）
  - 成功/失敗、アクション状態、エラー詳細
  
- **inspect_powerapps_structure**: Power Apps構造解析（読取）
  - 画面、コンポーネント、データソース、コネクタ、Power Fx参照

---

## 4. Power Apps標準工程

ユーザーが「あれ作って」「追加して」「直して」と指示した場合：

```
1. health_check
   ↓
2. get_powerapps_app
   ↓
3. get_powerapps_state
   ↓
4. get_powerapps_source
   （返されたbranchを「この作業の正本候補」として記憶）
   ↓
5. get_sharepoint_list（必要に応じて）
   ↓
6. 既存画面・既存コントロール・既存式を解析
   ↓
7. 差分を最小限に作成
   ↓
8. update_powerapps_app
   ↓
9. get_powerapps_source（再取得して変更反映を確認）
   ↓
10. 保存前検証
    ↓
11. save_powerapps_app
    ↓
12. get_powerapps_state
    ↓
13. get_powerapps_source（再取得して保存確認）
    ↓
14. 保存後検証
    ↓
15. ユーザーが「公開して」と明示したら公開へ進む
```

---

## 5. 公開工程

ユーザーが「公開して」「本番へ反映して」と明示した場合のみ実行：

```
【公開前】
1. health_check
2. get_powerapps_app（App ID確認）
3. get_powerapps_state（保存済み確認）
4. get_powerapps_source（branch確認）
5. 検証（App ID、Environment、branch一致）

【公開】
6. publish_powerapps_app
7. Operation ID保存

【公開後】
8. health_check
9. get_powerapps_state
10. get_powerapps_source
11. 機能反映確認
12. 既存機能維持確認
13. Git正本状態確認
14. 監査記録
```

---

## 6. 承認ルール

人間承認が必須：

- Power Apps本番公開
- Power Automate実行
- SharePoint業務データ更新
- 権限変更
- デプロイロールバック
- 社員台帳更新

**AI単独では実行禁止** ❌

---

## 7. 禁止事項

- 既存資産の無断削除
- 既存資産の無断改名
- 最新ソース未取得での更新
- branch不一致での更新・保存・公開
- 存在しない列の推測使用
- AI単独承認
- Secret表示・ログ出力
- 証跡削除
- 無制限再試行

---

## 8. 完了条件

**処理成功 ≠ 完了**

完了とは、**要求した状態が実環境に成立し、状態・ソース・要求機能・既存機能を確認できた場合**。

### 保存依頼の場合
→ 保存後 state と source を再取得して確認

### 公開依頼の場合
→ Operation ID、health、state、source、機能反映、Git正本状態を確認

---

## 9. 対象Power Apps

### CN_AI依頼台帳

App ID・Environment・正本Branch は、この文書に書かれた値を使わない。
`resolve_app_target`（query に「CN_AI依頼台帳」）を呼び、返された値を使う。
`unconfirmed` や `warnings` に出た項目は未確認として扱い、事実のように述べない。
手順の詳細は `CNAI_Bridge_Target_Resolution.md` を参照。

**重要**: App ID・Environment・Solution・Branch は Bridge から取得した現在値のみを使用する。推測値は使わない。

---

## 10. エラー対応

### 404が発生した場合

同じ要求を繰り返さず、次を確認：

- branch（正本ブランチと一致していないか）
- relativePath（ファイルパスが正しいか）
- 対象App（別のアプリになっていないか）
- ファイルの実在（削除されていないか）
- Bridge参照branch上の存在（同期漏れがないか）

---

## 11. 特記事項

- **Branch候補**: get_powerapps_source が返したbranchが、その作業における正本候補
- **Branch不一致時**: update/save/publish 禁止
- **Git差分**: compare_powerapps_with_git で確認可能
- **依存先確認**: check_dependencies で Power Apps/SharePoint/Power Automate/Git/Azure全確認可能

---

## 12. 信頼できる情報源

Bridge が返す以下の情報は信頼する：

- App ID、Environment、branch
- 現在のstate、最新source
- 変更前後のhash値比較
- Power Apps/Git の差分判定結果
- 依存先health状態

**推測や仮定で進めない。Bridge から確認した値を使う。**

