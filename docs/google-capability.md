# Google Capability（Sheets / Drive / GAS / CNKK）

CNAI Router の `googleWorkspace` Route。`platformHint` は `google` / `sheets` / `drive` / `gas` / `appsscript` / `cnkk`。
実装担当は Gemini（`implementationOwner`）。実行は既存Google OAuth（refresh token）でGoogle REST APIを呼ぶ。Gemini CLI実行ではなく、Gemini Registryが BLOCKED でも REST 実行は妨げない（`ownerStatus`で表示）。追加課金なし・APIキー不使用・AppSheet API不要。

| capability | 自動実行 | Human Gate | 備考 |
|---|---|---|---|
| gas.read / gas.verify / sheets.read / drive.read / cnkk.read | ○ | - | 読取のみ。`gas.verify`は期待値(`expectedManifestHash`/`expectedFiles`/`checkDeployments`)が無ければPASSにしない |
| gas.update / gas.deploy | - | **必須**（`approvedByHuman:true`） | 承認前はAPIを一切呼ばない |
| gas.execute | allowlist関数のみ | allowlist外は必須 | `GOOGLE_GAS_READONLY_FUNCTIONS`。実行成功だけでは`verified`にしない |
| sheets.update / cnkk.update | ○ | - | Snapshot→更新→再取得照合 |

CNKK = Google Sheets（`GOOGLE_CNKK_SPREADSHEET_ID`）＋必要時GAS（`GOOGLE_CNKK_GAS_SCRIPT_ID`）。未設定なら推測せず `ADAPTER_NOT_CONFIGURED`。

書込みは必ず 変更前Snapshot（`snapshotId`・メモリ保持）→ 書込み → 再取得 → 照合 → Evidence（`lastDispatchOutput.evidence`）。照合不一致は `VERIFICATION_FAILED`（COMPLETEDにしない）。出力は `maskDeep` 済み。

## 呼び出し例（`/router/request` または MCP `cnai_route_request`）
```json
{ "requestType": "gas.update", "platformHint": "gas",
  "payload": { "params": { "scriptId": "…", "files": [ {"name":"appsscript","type":"JSON","source":"…"}, … ] } } }
```
承認待ち(`BLOCKED`/`HUMAN_APPROVAL_REQUIRED`)の後、人間が承認したら `/router/request/:id/resume` に **同じ payload** と `"approvedByHuman": true` を送る。
`gas.update` の `files` は `appsscript`マニフェストを含む全ファイル（Google APIは全置換）。

## 制約・未検証
- 実Google環境での疎通は未検証（単体テストは注入クライアント）。OAuthのスコープ追加が必要な場合は人間のconsentが必要。
- 環境変数名 `GOOGLE_OAUTH_*` は本リポジトリに既存Google OAuth実装が無いため新設した名称。既存の値を同名で設定する。
- Snapshotはプロセスメモリのみ（再起動で消える）。復元は保存済みSnapshotの`files`で`gas.update`（承認要）。
