# Google Workspace Capability（Gemini / Gmail / Chat / Drive / Sheets / Docs / Calendar / GAS / AppSheet CNKK）

経路: スマホ → Copilot → (`/connector/mcp` `cnai_google_request`) → CNAI Router(`googleWorkspace`) → Gemini担当 → Google Workspace。
`requestType` が `gmail.send` 等のcapability名なら、`platformHint`なしでRouterが自動選択する（`gemini`/`google`ヒントも可）。

実装担当は Gemini（`owner`/`implementationOwner`）。実行は同一Workspaceドメインの既存Google OAuth（refresh token）でGoogle REST APIを呼ぶ。**Gemini CLI実行ではない**（CLIはRegistry上BLOCKEDのまま。`gemini.status`で確認）。追加課金なし。

## Capability一覧
| capability | 自動 | Human Gate | 最小scope |
|---|---|---|---|
| google.status / gemini.status | ○ | - | （consent不足の診断。トークンは返さない） |
| gemini.generate | ○（既定OFF） | - | generative-language.retriever。`GOOGLE_GEMINI_ENABLED=true`のみ |
| gmail.read | ○ | - | gmail.readonly |
| gmail.draft | ○ | - | gmail.compose（作成→再取得照合） |
| **gmail.send** | - | **必須** | gmail.compose + gmail.readonly |
| chat.read | ○ | - | chat.messages.readonly |
| **chat.send** | - | **必須** | chat.messages.create + readonly |
| drive.read | ○ | - | drive.metadata.readonly |
| sheets.read | ○ | - | spreadsheets.readonly |
| **sheets.update** | - | **必須** | spreadsheets |
| docs.read | ○ | - | documents.readonly |
| **docs.write**（append/replace） | - | **必須** | documents |
| calendar.read | ○ | - | calendar.events.readonly |
| **calendar.write**（create/update。削除なし） | - | **必須** | calendar.events |
| gas.read / gas.verify | ○ | - | script.projects.readonly (+deployments) |
| **gas.update / gas.deploy** | - | **必須** | script.projects (+deployments) |
| gas.execute | allowlist関数のみ | allowlist外は必須 | script.scriptapp |
| appsheet.read / **appsheet.write**（Add/Edit） | read ○ | write 必須 | （AppSheet APIは任意・未設定ならfail-closed） |
| cnkk.read / **cnkk.update** | read ○ | update 必須 | 既定=Sheets。`GOOGLE_CNKK_BACKEND=appsheet`でAppSheet |

各capabilityは**そのscopeだけに絞ったアクセストークン**を取得する（refresh tokenの`scope`サブセット）。広域scope（`mail.google.com`、全Drive等）は使わない。

## 実行パイプライン（write）
Human Gate（承認前はGoogle呼び出しゼロ）→ 変更前Snapshot → 実行 → 再取得 → 照合 → Evidence → Verifier（`verifier.status` = PASS/FAIL/NOT_VERIFIED）。照合不一致は `VERIFICATION_FAILED`（COMPLETEDにしない）。
- gmail.send: 下書き作成→承認内容と照合→不一致なら削除して中止→送信→SENTを再取得。宛先は`GOOGLE_WORKSPACE_DOMAIN`内のみ（外部は`allowExternal:true`+承認。ドメイン未設定は送信拒否）。ヘッダ注入は拒否。
- docs.write: `requiredRevisionId`付きbatchUpdate。calendar: `sendUpdates=none`。
- 出力・Evidenceは`maskDeep`済み。

## 承認フロー（スマホから）
1. Copilotが `cnai_google_request` を呼ぶ。この入口は読取専用窓口のため `approvedByHuman` を渡せない。
2. 書込み系は **BLOCKED / HUMAN_APPROVAL_REQUIRED** で `approval.summary`（宛先・件名・本文ハッシュ等）・`proposalHash`・`routerRequestId` が返る（Googleは未実行）。
3. 承認者が認証付き `POST /router/request/:routerRequestId/resume` に `{"approvedByHuman":true,"approvedProposalHash":"<hash>"}` を送る。**実行されるのは提案時のpayload**。異なるpayload/hashは `APPROVAL_PAYLOAD_MISMATCH` で拒否。
   （承認操作そのものを電話から行うUI（Teams/Power Automate承認等）は未実装。上記エンドポイントを呼ぶ承認フローが別途必要。）

## 本人操作（最後に1回）
同一Workspaceドメインの既存アカウントで **初回OAuth同意を1回**:
`node scripts/google-consent-plan.js` → 全scope（16件）を1つの同意URLで提示。得たrefresh tokenを `GOOGLE_OAUTH_REFRESH_TOKEN` に設定（環境変数のみ）。
`google.status` で不足scopeを確認できる。ほか環境変数: `GOOGLE_WORKSPACE_DOMAIN`、必要に応じ`GOOGLE_CNKK_*`。

## 未検証・制約
- 実Google環境での疎通は未実施（単体/統合テストは注入クライアント）。
- Snapshotはプロセスメモリのみ（再起動で消える）。復元は保存済みSnapshotで該当writeを承認付きで再実行。
- 提案(pending)もメモリ保持のため、Bridge再起動後の承認は不可（再提案が必要）。
- `gas.execute`成功は副作用の検証にならない（`verified:false`）。別途`gas.verify`/read。
- `GOOGLE_OAUTH_*` 等の環境変数名は新設（既存実装がリポジトリに無いため）。
