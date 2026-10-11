# Agent Registry 証跡（2026-10-11）

## 対象
- ブランチ: feature/agent-registry-20261011（origin/main から作成）
- 目的: Capability Registry の上に Agent Registry 実行レイヤーを追加し、`get_agent_registry` で登録状況を返す。

## 登録Agent（11）
CommanderAI / ResearchAI / DesignAI / ImplementationAI / TestAI / AuditAI / ReleaseAI / RecoveryAI / ProfitAI / CollectionAI / OptimizationAI

各Agentは `allowedTools` / `allowedCapabilities` / `riskLevel` / `approvalRules` を持つ。
ツールの capability（read / write / approval）は Agent 側で宣言せず、`bridgeCapabilities.js` の分類器から導出する（単一の正本）。

## 制約の実装
- `update_permissions`: どのAgentにも割当不可（全Agent共通の禁止）。
- `deploy_to_test` / `verify_deployment` / `publish_powerapps_app`: ReleaseAI のみ保持可。
- 承認必須ツールは `approvalRules` 必須。approvalRules は許可済みツールのみ参照可。
- riskLevel は保持ツールの最大リスクを下回れない。
- 本番変更・Power Apps保存/公開・権限変更は本PRに含まれない（読み取り専用のレジストリ応答のみ）。

## 変更ファイル
- src/agentRegistry.js（新規）
- src/bridgeCapabilities.js（分類器のexport追加、`get_agent_registry` を読み取り専用に分類）
- src/server.js（`get_agent_registry` をMCP_METHODS / MCP_PUBLIC_TOOLS / dispatchに追加）
- test/agentRegistry.test.js（新規・18件）
- test/stateContextContract.test.js（公開ツール数 72→73 に更新）

## テスト結果（CI同等環境変数）
- `npm test`: 1323 tests / 1323 pass / 0 fail
- `npm run validate:openapi`: exit 0
- `npm run test:mcp-tools`: 146 pass / 0 fail
- `npm run test:safety`: 9 pass / 0 fail

## 回帰影響
- 既存ツールの分類結果は変更なし（追加は `get_agent_registry` のみ）。
- 公開ツール数は 73。

## 公開ゲート・本番
- Power Apps 保存・公開: 実行なし。
- 本番Bridgeデプロイ: 本PRはmainへマージしない限りデプロイされない。マージは未承認のため未実施。
