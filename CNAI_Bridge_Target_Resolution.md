# アプリ対象解決（Copilot Studio / CNAI 用 Knowledge）

## 使い方
ユーザーが「CN_AI依頼台帳」のようにアプリ名だけ言ったら、まず `resolve_app_target` を呼ぶ。
App ID・Environment・Branch をユーザーに質問しない。

## 返却の読み方
- `status: ok` … App ID・Environment・正本Branch・gitRoot が確認できた。実装に進んでよい。
- `status: partial` … 一部が未確認。`unconfirmed` / `warnings` を読み、未確認項目を事実のように扱わない。
- `status: ambiguous` … 候補が複数。`candidates` を示してユーザーに選んでもらう（この場合のみ質問する）。
- `status: not_found` … 一覧を取得できた上で該当なし。
- `status: unavailable` … 一覧を取得できていない。アプリの有無は未確認。存在しないと言わない。

## 情報の出どころ
- App ID: Dataverse（canvasapps）から取得
- Environment: 構成値 POWERAPPS_ENVIRONMENT_ID（一覧は Power Platform 管理API、権限不足なら構成値のみ）
- 正本Branch: 構成値 POWERAPPS_GITHUB_BRANCH（書き込み対象はこのBranchのみ）
- gitRoot・別名・公開承認者: config/application-rules.json（ユーザー確認済みの事実のみ）

## 安全ルール
- 公開は `approvalRequired: true`。承認者の確認なしに publish しない。
- 正本Branchに gitRoot が無い場合（warnings に表示）は、書き込み前にユーザーへ確認する。
- すべて読み取り専用。Knowledgeへの保存・更新は行わない（`export_knowledge_snapshot` は文面を生成するだけ）。
