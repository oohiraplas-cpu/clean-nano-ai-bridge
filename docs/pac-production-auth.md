# 本番BridgeのPAC認証設定と実統合テスト

## 現在の実行範囲

ユーザーは本番 `clean-nano-ai-bridge` へのPAC認証設定を希望しています。
PR #83はドラフトのままです。この希望だけではPRのmainマージ・本番
デプロイ・Power Appsの保存/公開/権限変更を実行しません。

このCodex実行環境にはAzure管理用接続、Managed Identity、PAC、Azure CLIが
ありません。業務Bridge MCPはApp Service設定用の接続ではありません。
したがって以下は実行可能な準備手順であり、**本番への設定完了報告ではありません**。

## 認証方式

第一候補は本番App Serviceに既に割り当てられた専用のユーザー割り当て
Managed Identityです。既存IDがなければシステム割り当てIDの利用可否を
確認します。IDが有効であること、Power Platform側でそのIDが認識されること、
対象canvasアプリを実際にダウンロードできることを別々に確認してください。
Azureでのトークン取得成功やDataverseへの認証成功だけでは採用確定にしません。

PACは `pac auth create --managedIdentity` に対応しています。ただし内部は
DefaultAzureCredentialです。認証チェーン制限に使う
`AZURE_TOKEN_CREDENTIALS=ManagedIdentityCredential` はPAC同梱の
Azure.Identityが1.15.0以降であることを確認した場合に使用してください。
そのバージョンを確認できない場合、Managed Identity以外へのフォールバックを
防げるとは扱いません。

既存Bridgeは `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` を利用する可能性が
あります。これらの本番アプリ設定をManaged Identity用の値で上書きしないで
ください。PAC専用の子プロセス/実行ラッパーで認証環境を分離する必要があります。
現在のPRのアダプターは親環境を継承するため、認証分離の実装と検証が済む前に
`POWERAPPS_RUNTIME_SOURCE_ADAPTER=pac` を本番で有効化しません。

## 設定前の読み取り確認

Azure管理接続を持つ担当者/実行環境で次を確認します。リソースグループ名、
Managed IdentityのClient ID/Principal IDは実取得し、推測しません。

1. 対象App Serviceの完全なリソースIDと既存Managed Identityの割り当て。
2. 本番ホストのOS、PAC/Python/.NETの実体とバージョン、永続領域、実行ユーザー。
3. PR #83のState Context契約/アダプターが本番に存在するか。
   変更未反映なら本番統合テストの前提は未充足です。勝手にデプロイしません。
4. PAC専用プロファイルの保管先とアクセス制限、既存認証との分離方法。
5. 対象EnvironmentにManaged Identityのapplication userが存在するか。
   作成/ロール付与が必要ならここで停止し、対象・必要権限を具体化します。
   AzureのReader/Website ContributorはPower Apps取得権限ではありません。

## PAC認証の初期設定

これは**本番App Service上のPAC専用実行環境**で行う初期設定です。
Azure Cloud ShellやローカルPCで実行しても本番ホストのPAC認証にはなりません。
requestごとのアダプター処理でauth create/selectを呼びません。

既存の非秘密IDと実行環境を確認し、Managed Identity専用の環境で次を実行します。
ユーザー割り当てIDの場合、専用子プロセスの `AZURE_CLIENT_ID` に実取得した
Client IDを設定します。システム割り当てIDでは専用子プロセスに旧SPNの
`AZURE_CLIENT_ID` を継承させません。環境認証、証明書、Workload Identityや
開発者の認証へのフォールバックを排除し、MI失敗なら停止します。

```sh
pac auth create --managedIdentity \
  --environment 4d0aab59-43ec-ecf1-a9d1-869f2517adbb \
  --name bridge-runtime-mi
```

実行時のstdout/stderrは診断ログへ保存/貼り付けせず、保護されたホスト上で
成功/失敗と選択IDのみを確認します。`pac auth token`、環境変数全出力、
プロファイルファイル内容の表示は禁止です。プロファイルは必要最小限の
アクセスに限定し、秘密値が必要になる別方式へ勝手に切り替えません。

## 対象アプリの実取得確認

PAC専用環境で次の読み取りのみを行います。

```sh
pac canvas list --environment 4d0aab59-43ec-ecf1-a9d1-869f2517adbb
pac canvas download --name f42a9b03-59b9-49d3-a33b-0a210cd3d51e \
  --environment 4d0aab59-43ec-ecf1-a9d1-869f2517adbb \
  --file-name <アクセス制限された一時ディレクトリ内のapp.msapp>
```

CLI出力と.msappは秘密/接続情報を含み得るためログへ出しません。
対象App IDが一覧に存在し、downloadが成功することを確認します。
パッケージ中の正確な `Src/*.pa.yaml` entryをローカルで確認して
`powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml` に対応付けます。
entryが存在しなければ `source_unavailable` とし、再保存や形式変換はしません。
検査後は一時パッケージを削除します。

アプリへの閲覧権限だけではソースのエクスポートが許可されない可能性があります。
403等が発生した場合、Co-owner/管理者/環境全体権限を自動付与せず、必要な
export権限を特定して報告します。認証成功をexport成功と読み替えません。

## アダプター有効化とCopilot Studio実統合

コードの反映・PAC実体・専用認証・実取得entryがすべて確認できた後に、
`docs/state-context-contract.md` の非秘密設定を本番へ適用します。
App Service設定保存はアプリ再起動を伴うことがあるため、適用差分、戻し方、
停止時間を具体化してから適用してください。今回Azure接続がないため差分未作成です。

Copilot Studio CNAIで既存Bridge MCPのツールを再取得し、同じ会話/実行sessionで
次を順に呼びます。

1. `health_check`
2. `get_powerapps_state`: App ID/Environmentが対象と一致し、correlationIdと
   stateSessionIdが返ること。
3. `get_powerapps_source`: 明示したGitファイル、main、完全なstateContextが返ること。
4. `validate_powerapps_source`: 上記context/sessionをそのまま渡して `VALID`。
5. `compare_powerapps_with_git`: 同一context/session、対象ファイル/App IDで実行。
   `identical` または `changed` と `comparisonVerified=true` を確認。

GitのSHAは各回の実取得blob SHAを使用します。過去SHA、固定correlationId、
不足項目の補完は禁止です。`source_unavailable` / `validation_blocked` は
未成功と記録します。差分の有無、対象SHA、ファイル/変更行/プロパティのみを
証跡にし、ソース値、認証値、session capabilityは記録しません。

既存probeのHTTP成功はCopilot Studio UIの成功を証明しません。
CNAI上での5段階の呼び出し結果を別途確認し、PR #83へ結果と残件を追記します。

## 公式資料

- [PAC認証とAzure Identity](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/auth)
- [Azure Identity認証チェーン制限](https://learn.microsoft.com/en-us/dotnet/azure/sdk/authentication/credential-chains)
- [Managed Identityのapplication user](https://learn.microsoft.com/en-us/power-platform/admin/manage-application-users)
- [PAC canvas download](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/canvas)
