# CNAI 接続・実装の実測記録（2026-09-28）

## 調査した実環境

| 資産 | 実測結果 | 現時点の扱い |
| --- | --- | --- |
| Copilot Studio | `CN_総合秘書AI`、Default 環境 `Default-aa0b99c9-b756-4611-970a-6c31013c42e3`、agent ID `f8e524ac-4ca0-f111-b8dd-6045bd524d04`。2026-09-23 公開。 | 既存名称を保持。CNAI は発展先の呼称。 |
| エージェントのナレッジ | 詳細画面のナレッジ欄は空。指示文は SharePoint を正本とし、無承認の更新を制限。 | 知識源の実追加・検索結果は未検証。 |
| エージェントのツール | `clean-nano-AI-bridge` 外部エージェント、`CN_AI_Bridge` の `Copilot Webhook`、`Get Next Task`、`Get Tasks`、`Health Check`、Work IQ の Calendar/OneDrive/SharePoint/Teams/Mail（プレビュー）が表示。 | 表示と実行権限は別。チャットで Health Check を依頼した際に実呼び出しできず、後続の試行では「接続できません」。 |
| Copilot Studio ツール定義の再確認（2026-09-29） | `Get Tasks` は有効で既存 `CN_AI_Bridge` 接続が選択済み。コードビューでは `InvokeConnectorTaskAction`、`operationId: GetTasks`、`connectionProperties.mode: Invoker`、出力 `Response`。`Health Check` も有効・接続選択済み。19:05〜19:19 JST のテスト会話は両者を呼ばず、利用可能なツールにないと応答。 | 接続表示だけで実行成功と見なさない。Invoker の利用者接続とオーケストレーション、実行トレースを次に確認。原因は未確定。 |
| Bridge MCP のスイッチ | `health_check`、`get_tasks`、`get_next_task` がオン。`create_task`、`get_task_result`、`update_task_status`、Power Apps の更新系はオフ。 | 権限拡張なし。 |
| Bridge API | 接続済み「あか」から `health_check` は `ok`、`get_tasks` は4件、`get_powerapps_app`、`get_powerapps_state`、`get_powerapps_source` は応答。 | API単体の確認。Copilot Studioからの到達性を意味しない。 |
| Power Apps | `CN_AI依頼台帳`、app ID `f42a9b03-59b9-49d3-a33b-0a210cd3d51e`、clean nano 環境 `4d0aab59-43ec-ecf1-a9d1-869f2517adbb`。2026-09-28 公開。 | 既存アプリを維持。エージェントの環境と異なる。 |
| Power Apps データソース | CN_AI依頼台帳、CN_勤怠明細台帳、CN_社員マスタ、CN_社員台帳、CN_現場台帳、CN_電子日報台帳、CN_資格台帳、CN_本人マイデータ、CN_申請台帳、ドキュメント、Office 365 Users。 | アプリ状態から取得。全画面と列の動作は未検証。 |
| Power Automate / Default | `CN_AI実行ゲートウェイ` はオフ、2026-09-08 作成、Power Apps V2 トリガーだけの下書き。接続参照なし、実行履歴なし。`CN_電子日報_保存` はオン。 | ゲートウェイを稼働中と見なさない。 |
| Power Automate / clean nano | `CN_日報PDF保存` はオフ。Document Automation Validator/Processor はオン、Email Importer はオフ。 | 既存フローとの重複を避ける。 |
| SharePoint | `hisyoengineer.sharepoint.com/sites/cleannano`。既存 `CN_AI依頼台帳` をBridge経由で2件読み取り、リストID `973f17d6-3566-4795-9712-2386bb7bf540` を確認。文書ライブラリと日報PDFの所在も確認。 | 正本候補を実測。列の完全な仕様・閲覧権限の範囲は未確認。 |
| Bridgeタスクと既存依頼台帳の照合（2026-09-29） | `get_tasks` は5件。上記リストの再読取は3件で、BridgeタスクのID・件名に対応する項目はない。`demo-001` はリポジトリの開発用 `data/tasks.json` にも存在する。 | **同じ正本への保存は未確認**。現時点の値は一致せず、Bridgeの実際の `TASK_STORE_BACKEND` と接続先リストIDを配備設定で確認する必要がある。 |
| GitHub | `oohiraplas-cpu/clean-nano-ai-bridge`。PR #30 の Actions でAPIテストを実施。Azure Web App 配備は手動ワークフロー。 | PR は下書きで未マージ・未配備。 |
| Azure、freee、M365接続の実認証 | この調査でAzure配備設定・freee連携・Outlook/Teamsのエージェント実行結果は取得できず。 | 接続済みと表記しない。秘密値は記録しない。 |
| Azure設定の取得（2026-09-29） | GitHub配備ワークフローは手動 `workflow_dispatch`、対象Web Appは `clean-nano-ai-bridge`、OIDCログインを使用。Azure Portal の実アプリ設定は未取得。 | アカウント選択の自動承認審査が、個人用・任意アカウントを含む要求を却下。`TASK_STORE_BACKEND` の実値を推測しない。 |

## 今回の実装と検証範囲

- 既存PR #30 に、MCP `get_bridge_readiness` を追加。認証の設定有無、タスク保存先、SharePoint・Power Apps・フローの設定有無、選択中タスク保存先の読み取り疎通だけを返す。鍵、トリガーURL、上流エラー本文を返さない。
- ファイル保存先、SharePointタスク設定不足、保存先疎通失敗、MCP認証未設定を `findings` の機械可読コードで示す。ファイル保存先が読めてもSharePoint正本との一致は証明されない。
- 既存の 3AI 受付経路と承認待ち停止のクラウド試験に、診断ツールの情報秘匿・障害時表示の試験を追加。
- `configured` は設定済みの意味であり、SharePoint、Power Apps、Power Automate、Copilot Studio の全体接続試験ではない。

## 接続を完成させる順番

1. Copilot Studio の既存Bridge接続における認証・有効なツールの実行失敗を調査し、Health Check の実応答を確認する。
2. 既存 `CN_AI依頼台帳` とBridgeタスク保存先が同一の正本かを、IDと列定義で照合する。異なる場合は新しい台帳を増やさず既存の正本に合わせる。
3. `CN_AI実行ゲートウェイ` の用途と所有者、必要な接続参照を確認し、隔離されたテストで入力→承認→実行→結果照合を検証する。現状はトリガーのみでオフ。
4. 見積、現場、請求、採用等は既存リスト・文書と実権限を業務単位で照合し、読み取りと実行準備から接続する。送信、会計記帳、給与控除、督促、法的提出などは個別の承認と結果照合を経て実行する。

今回の証跡は GitHub Actions のPR実行、Copilot Studio/Power Automate の実画面、Bridge/SharePointの読み取り応答。PR試験の成功は本番CNAIの完成を示さない。
