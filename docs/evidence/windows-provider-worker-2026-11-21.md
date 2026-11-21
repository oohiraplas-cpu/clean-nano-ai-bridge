# Windows Provider Worker Evidence (2026-11-21)

基準commit: 057ab5c（clean-nano-ai-bridge main）。※指示の `cbfb2cf` は両リポジトリに存在しない。

## 前提との差異（実測）
- 「AI Job Queue / Capability Registry / OZ Router / Wallboard」という名称の実装はリポジトリに無い。実在するのは `src/windowsJobs.js`（Executor Queue: register/heartbeat/submit/pull/checkpoint/result）と `src/cnaiRouter.js`。
- Queueを土台に拡張し、Registryは `config/ai-provider-registry.json` を新設した。Wallboard実体は無いため、参加条件（ACTIVEのみ）を `wallboardProviders()` として実装するに留まる。

## 構成
- `src/windowsJobs.js`: ジョブに `provider/repository/branch` を追加。`pull` は `providers` 指定時のみprovider jobを払い出し、未指定（既存Executor）はprovider jobを取らない。
- `src/providerWorker.js`: allowlist、引数配列(shell:false)実行、プロンプトはstdin、timeout、出力上限、二重実行防止（メモリ+lock+done marker）、秘密値マスク、APIキー環境変数の非転送、git commit/worktree証跡。
- `scripts/provider-worker.js`: Workerループ（claim=/job/pull, status=/job/checkpoint, complete/block=/job/result）、`--probe`、`--selftest`。Auditは `data/provider-worker/audit.jsonl`。
- `config/provider-policy.json` / `config/ai-provider-registry.json`

## Provider別結果
| provider | CLI | 実呼び出し | Registry |
|---|---|---|---|
| claude_code | `claude` 2.1.330 | selftest PASS（Linux検証環境、exit 0、期待文字列一致、worktree無変化） | ACTIVE（windowsVerified=false） |
| gemini | PATHに無し | 不可 | BLOCKED（解除: Windows実機へCLI導入・ログイン後 selftest PASS） |

## テスト
`npm test`: 1834 pass / 0 fail（新規 `test/providerWorker.test.js` 10件: 実行・マスク・allowlist・timeout・二重実行・AUTH/非ACTIVE/CLI無し・Queue E2E・Audit）。

## 未検証
Windows実機での起動・CLI実呼び出し（本環境はLinux）。追加課金なし（APIキー非使用、新規有料API無し）。

## merge後確認（追記）
- PR #268 を merge: `cd0908b6d3c38dff5a6d99c63a94ab0794d0d255`（merge時のhead `c9a54b6`）。
- merge後のpush workflowはすべて success:
  - clean-nano-bridge Integration Test #2273
  - Phase 6 Validation - State Manager Enforcement #105
  - Verify Production Bridge 28 Tools Two Pass #74（非破壊の本番検証）
  - Build and deploy Node.js app to Azure Web App #223（既存の自動デプロイ。手動デプロイ・本番操作なし）
- 本番にデプロイされたのはBridge側の `provider` 対応のみ。Provider WorkerはWindows実機で動かす別プロセスで、本番では未起動。
- 本番URLへの個別のhealth呼び出しは未実施（Verify Production Bridge の成功で代替）。
- branch protectionの設定は直接確認していない（mergeable=clean を根拠にした）。

## 未解決
- Windows実機での `--probe` / `--selftest claude_code`（claude_codeは `windowsVerified=false`）。
- Gemini CLI未導入（BLOCKED）。
- 指示にあった基準commit `cbfb2cf` と OZ Router / Capability Registry の実体は、本リポジトリで確認できていない。
