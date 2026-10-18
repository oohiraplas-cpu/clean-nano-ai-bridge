# RecoveryAI / QueueAI 追加設計

最終更新: 2026-10-12
状態: **設計のみ**（コード・Agent Registry・MCP 公開ツールは変更しない）

## 0. 前提

- Execution Queue の永続化・復旧・冪等性・監査・ロールバックは PR #132 で実装（ExecutionStore / ExecutionQueue / ToolExecutor）。
- 人間承認は承認台帳で確認する。AI は承認を作成・更新しない。承認フラグによる承認は存在しない。
- 本設計の実装は、設計の承認後に別 PR で行う。Agent Registry の変更は、既存テストと MCP 公開ツールの整合性テストを通すこと。

## 1. RecoveryAI（既存・拡張案）

### 現状（src/agentRegistry.js）

| 項目 | 値 |
|---|---|
| role | 障害時の切り戻し・復旧 |
| capabilities | rollback, dependency_diagnosis |
| allowedTools | rollback_deployment, check_dependencies, get_deployment_logs |
| humanApprovalRequired | rollback_deployment |

### 役割（拡張案）

実行キューで停止・中断した依頼の**診断と復旧提案**を担当する。自分では実行を再開しない。

| 操作 | 種別 | 承認 |
|---|---|---|
| 停止理由・中断手順・監査履歴の診断 | 読み取り | 不要 |
| 中断手順（実行中）の実行有無の調査 | 読み取り | 不要 |
| 依頼の再開（resume, confirmNotExecuted） | 状態変更 | **人間承認必須** |
| 依頼のロールバック（rollback） | 状態変更 | **人間承認必須** |
| 補償が必要な完了済み手順の一覧提示 | 読み取り | 不要 |

### 追加候補ツール（MCP 公開は別途承認）

- `get_execution_status`（既存の方向。公開は要検討）
- `get_execution_audit`（新規。依頼ごとの監査履歴の読み取り）
- `resume_execution_request`（新規。**humanApprovalRequired**）
- `rollback_execution_request`（新規。**humanApprovalRequired**）

### 禁止事項

- 中断手順を、実行有無を確認せずに再実行する
- 承認なしに resume / rollback を行う
- 外部システムの取り消し（補償）を自動で行う（補償は人間が判断し、別の承認ゲートで実行する）
- rollback_deployment の本番ロールバックを承認なしで行う（既存の規則を維持）

## 2. QueueAI（新規）

### 役割

実行依頼の**投入・優先順位の確認・待機状況の報告**を担当する。依頼の実行（advance）は担当しない。

| 項目 | 案 |
|---|---|
| id | QueueAI |
| name | QueueAI |
| role | 実行キューの投入・待機管理 |
| capabilities | queue_submission, queue_monitoring |
| allowedTools（案） | create_execution_request, get_execution_queue, get_execution_status, get_checkpoint |
| humanApprovalRequired | [] |

### 理由

- `create_execution_request` は依頼を登録するだけで、外部ツールを実行しない。承認が必要なステップは、キュー側で承認台帳を確認してから進む。
- 読み取り系（queue / status / checkpoint）は副作用がない。

### 必須の制約

- `idempotencyKey` を必ず付けて投入する（再送による二重登録を防ぐ）。
- 承認が必要な手順を含む依頼は「人間承認待ち」で開始する（既存の挙動）。QueueAI は承認を作らない。
- 実行（advance）・再開（resume）・ロールバックは QueueAI に含めない。
- 依頼の優先度（high / normal / low）は、QueueAI が自分で上げない（人間が指定したもののみ）。

## 3. 権限の分離（職務分掌）

| 役割 | できること | できないこと |
|---|---|---|
| QueueAI | 依頼の投入・閲覧 | 実行、承認、再開、ロールバック |
| RecoveryAI | 診断、復旧の提案 | 承認なしの再開・ロールバック、承認の作成 |
| 人間 | 承認台帳への承認記録、再開・ロールバックの承認 | （承認の代理は行わない） |
| 実行器（ToolExecutor） | 接続済みツールの実行と検証 | 承認の判断 |

## 4. 実装時のテスト計画（設計承認後）

1. Agent Registry: 新規・変更エージェントの allowedTools が公開ツール一覧に存在すること（既存テストで検証）
2. QueueAI の allowedTools に advance / resume / rollback が含まれないこと
3. RecoveryAI の resume / rollback が humanApprovalRequired に含まれること
4. QueueAI の投入が idempotencyKey なしでは拒否されること（運用ルールとして、投入ツール側で必須化）
5. 承認台帳未設定時、承認が必要な依頼は人間承認待ちのまま進まないこと（PR #132 のテストを再利用）

## 5. 未確定事項（設計承認時に決める）

- 新規公開ツール名（上記は案）
- MCP 公開の時期（PR #132 のマージ後）
- 依頼投入のレート制限（QueueAI の過剰投入の防止）
- 監査履歴の公開範囲（依頼者の範囲）

## 6. 承認ゲート

| 操作 | 承認 |
|---|---|
| 本設計 PR の作成・レビュー | 不要（ドキュメントのみ） |
| Agent Registry への QueueAI 追加 | 人間承認が必須 |
| RecoveryAI の権限拡張 | 人間承認が必須 |
| MCP 公開ツールの追加 | 人間承認が必須 |
| main へのマージ | 人間承認が必須 |
