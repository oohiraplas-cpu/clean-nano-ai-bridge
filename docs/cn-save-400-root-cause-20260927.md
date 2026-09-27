# CN_AI依頼台帳 保存400の原因候補と安全な対処

## 確認済み
- Power Apps API で appId `f42a9b03-59b9-49d3-a33b-0a210cd3d51e`、environmentId `4d0aab59-43ec-ecf1-a9d1-869f2517adbb`、unmanaged solution uniqueName `CN_AIIraiDaicho` が取得できる。
- `save_powerapps_app({})` は `Dataverse PullChangesFromGit エラー (400): Not a valid solution` で停止。
- `src/server.js` の save 実装は `refreshFromGit` → `pullFromGit` → `powerAppsStore.saveApp`。したがって本体 saveApp に到達する前に失敗した可能性が高い。
- `src/config.js` の未設定時既定値は旧 org `orgcf455a58`、旧 solution `CN_CompanyOS`、旧 source root `powerapps/CN_CompanyOS_ElectronicDailyReport/Source`。現在の対象とは一致しない。**Azureの実際の環境変数が未確認のため原因確定ではない**。

## 読取専用の確認順
1. Azure Web App Configuration の `POWERAPPS_ORG_URL` が `https://org0bbb24c5.crm7.dynamics.com`、`POWERAPPS_ENVIRONMENT_ID` が `4d0aab59-43ec-ecf1-a9d1-869f2517adbb`、`POWERAPPS_APP_ID` が `f42a9b03-59b9-49d3-a33b-0a210cd3d51e`、`POWERAPPS_SOLUTION_UNIQUE_NAME` が `CN_AIIraiDaicho` かを**値を外部出力せず現地照合**。認証秘密値は表示しない。
2. `POWERAPPS_GITHUB_BRANCH` と `POWERAPPS_GITHUB_ROOT` が実際の対象アプリ専用ソースと一致するか確認。現在確認できたエクスポートは `powerapps/CN_AI依頼台帳/Source/S2_Calendar.pa.yaml` 等、branch `fix/cn-aiiraidaicho-safe-export-20260926`。このエクスポートが Dataverse Git 連携の正式なソリューション構造であるとは未検証。
3. Power Apps側のソリューション Git 接続が有効か、Git接続のルートに正規のソリューション構造があるか、接続ブランチが一致するか確認。`PullChangesFromGit` の400本文・リクエスト相関IDを機密値を伏せて収集。
4. 設定不一致を隔離ブランチで修正し、静的/単体テスト。**本番 `RefreshChangesFromGit`/`PullChangesFromGit` は原因解消・復元可能性が確認されるまで再実行しない**。
5. 復元試験・対象ソース一致・統合テスト後にのみ Power Apps本体保存。公開は別途判断。

## 安全改善
- save前に app ID、solution unique name、環境URL、Git branch/root を検証し、旧既定値や未検証ルートの場合はエラーで停止する。旧アプリの設定を全環境で一律変更しない。
- `RefreshChangesFromGit`/`PullChangesFromGit` は更新操作。read-only診断と分離し、変更前の承認ゲートを設ける。
