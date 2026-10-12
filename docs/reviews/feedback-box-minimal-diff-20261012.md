# ご意見ボックス 最小差分・読み取り検証（2026-10-12）
状態: REVIEW CANDIDATE / BLOCKED。PR #129 のDraftブランチのみ。未適用。
対象 App ID: f42a9b03-59b9-49d3-a33b-0a210cd3d51e
Environment ID: 4d0aab59-43ec-ecf1-a9d1-869f2517adbb

## 今回の確認済み証跡
- GitHub main/base commit: f0e809a4418ea0843b377fa3eee9e1d544cf6144。
- S7_Settings blob: e82d8e2a10332771685e3d4a76fcde05feeeb820。
- MainScreen1 blob: d316f13b18a7a64d989e9a790a51c256e3b527e6。
- Bridge health_check: status=ok。
- get_powerapps_state: App/Environment一致、versionNumber=2026-10-11T17:44:08Z。
- get_powerapps_source: S7_Settings blob一致。ただし sourceState=github_canonical。Power Apps保存済み実ソース比較の証明ではない。
- state応答: authorityContextComplete=true、sourceObservationComplete=false、stateContextComplete=false。
- 公開コネクタのget_powerapps_source引数はrelativePathのみ。correlationId/stateSessionIdを渡せない。現在のセッション完成・実ソース比較は未確認。
- 前工程PR HEAD 5b9b72a4d37103ee76dafbff39ae901feb2c642d のCI #737 success。今回更新HEADのCIとは区別する。

## SharePoint実列定義（読み取りで再取得）
siteId: hisyoengineer.sharepoint.com,6c84edee-5d0a-4501-b360-89881542f521,5e589c1f-2d73-48df-a550-a64f2f344d66
listId: 973f17d6-3566-4795-9712-2386bb7bf540

|内部名|表示名|型|確認事項|
|---|---|---|---|
|Title|依頼ID|text|必須false・書込可|
|RequestDateTime|依頼日時|dateTime|必須false・書込可|
|Requester|依頼者|personOrGroup|必須false・書込可。単一/複数・People制約と本人解決は未確認|
|RequestContent|依頼内容|text|複数行true・必須false|
|RequestCategory|依頼区分|choice|その他を含む。自由入力不可|
|AIRequestStatus|状態|choice|受付/処理中/完了/エラー|
|AIExecutionStatus|AI実行状態|choice|未実行/実行中/完了/エラー|
|_x627f__x8a8d__x72b6__x614b_|承認状態|text|必須false・書込可|

全列API応答で必須trueの列は見つからなかった。ただしContent Type固有制約・デフォルト値・Power Apps接続スキーマ・投稿ユーザーの項目作成権限は未確認。既存項目の変更はなし。

## 既存依頼フォームへの影響
MainScreen1 Form1を読み取り:
- DataSource=[@CN_AI依頼台帳]、Item=RecordsGallery1.Selected。
- NewForm(Form1); UpdateContext({newMode:true})で新規入力。
- SubmitFormButton1.OnSelect=SubmitForm(Form1)。
- DefaultModeはnewMode/editModeでNew/Edit/Viewを切替。
- OnSuccessはCurrentItemをLastSubmitに更新しnewMode/editModeをfalseへ。
- OnFailureはエラー通知のみ。
- RequestContentカードRequired=false。RequesterカードUpdate=DataCardValue2.Selectedで投稿者を変更可能。
- RequestCategory・AIExecutionStatusのカードはForm1に存在しない。
- Form1以外にも同リスト向けカード群があり、全画面再利用では影響範囲が広がる。
- 既存送信に送信中ロックなし。意見投稿用途での流用には追加制御が必要。
結論: 既存Form1を直接改変せず、S7_Settings内の入力パネル案を作成。既存依頼フォーム・新規/編集/成功/失敗処理を変更しない。

## フロー影響の読み取り結果
- GitHub main再帰treeを確認した範囲では、Power Automateの実フロー定義エクスポートは確認できなかった。
- src/powerAutomateRunner.jsはHTTP登録フローの実行アダプター。SharePoint項目作成トリガーや条件定義を取得する機能ではない。
- src/server.jsにはlist_registered_power_automate_flows等の登録があるが、現在公開されたBridgeコネクタにはフロー定義を読むツールがない。
- run_power_automate_flowは実行ツールなので読み取り検証の代用にはしない。
- 「その他」「受付」「未実行」を保存してもAI起動を防止できるとは証明できない。Title接頭辞も単独では防止策にならない。
- リストを参照する全フローのトリガー条件、分岐、承認条件、定期取得条件、更新時再実行条件の実定義を確認するまで保存処理はHOLD。フローの変更・実行なし。

## ボタン・入力UIの具体的差分
同フォルダの feedback-box-ui-candidate-20261012.patch を参照。
適用先は既存S7_Settingsのみ。レビュー用patchでありSourceファイルは更新していない。
- ご意見ボックスボタン: 緑、左右16、高さ52、Y=432。
- 開閉: locFeedbackOpenを画面内で変更。新規画面・アプリを作らない。
- 本文: 複数行入力。投稿者表示: User().FullName。
- 送信: DisplayMode.Disabled固定。OnSelectも警告通知のみで書き込みしない。
- 戻る: locFeedbackOpen=false。本文はパネル開閉で消さない。
- 既存S7_SrcのみYを432→496、Heightを画面高さに合わせて制限。既存コントロール15個とOnVisible/ナビの式は保持。
- 既存作業員切替とFirst(CN_社員台帳)の初期化は本人識別上の別課題として残る。今回のUIからgblEmpIDを投稿者として利用しない。本人認証が安全になったとの判定はしない。
- 640/768/844/1136の画面高さで静的なパネル・下部ナビの境界計算を確認。実機描画・キーボード・フォーカスは未検証。
- 保存候補を有効化する際は、エラー表示・キーボード配慮・未送信本文の離脱確認・送信中の閉じる制限も追加検証する。

## 保存処理の最小候補（未実装・未検証）
次のコードはレビュー候補。上記UI patchに含めず、Sourceにも保存しない。
gblFeedbackSaveVerifiedは現在false固定の条件として扱う。安全証跡の確認なしにtrueへ変更しない。
locFeedbackRequesterは現在ログイン本人に対応するSharePoint Personレコードを実接続で解決したものに限定する。
Personスキーマ・Power Appsの表示名マッピングは実接続確認後に確定し、推測のClaimsで代用しない。

```powerfx
If(
    !gblFeedbackSaveVerified,
    Notify("安全検証が未完了です。", NotificationType.Warning),
    If(
        locFeedbackSending,
        Notify("送信処理中です。", NotificationType.Information),
        If(
            IsBlank(Trim(S7_FeedbackBody.Text)) || IsBlank(locFeedbackRequester.Email),
            Notify("本文とログイン本人の確認が必要です。", NotificationType.Warning),
            UpdateContext({locFeedbackSending:true});
            IfError(
                With(
                    {posted: Patch(
                        [@CN_AI依頼台帳],
                        Defaults([@CN_AI依頼台帳]),
                        {
                            依頼ID: "ご意見-" & Text(GUID()),
                            依頼日時: Now(),
                            依頼者: locFeedbackRequester,
                            依頼内容: Trim(S7_FeedbackBody.Text),
                            依頼区分: {Value:"その他"},
                            状態: {Value:"受付"},
                            AI実行状態: {Value:"未実行"}
                        }
                    )},
                    If(
                        IsBlank(posted.ID),
                        Notify("保存結果を確認できません。本文を保持します。", NotificationType.Error),
                        Notify("ご意見を受け付けました。", NotificationType.Success);
                        Reset(S7_FeedbackBody);
                        UpdateContext({locFeedbackOpen:false})
                    )
                ),
                Notify("保存できません。本文を保持します。", NotificationType.Error)
            );
            UpdateContext({locFeedbackSending:false})
        )
    )
)
```

承認状態・AI回答・AI監査ID・完了日時・担当者はこの候補で書き込まない。
送信ボタンと戻るボタンは送信中無効化を追加する。
locFeedbackSendingは連打抑制であり、通信タイムアウト後の再試行に対する冪等性を保証しない。
応答不明時は自動再送せず、投稿IDでサーバー保存状況を照合する。既存Title列は一意制約未確認なので、重複なしと宣言しない。
本文最大長、Person型、表示名、AIExecutionStatus接続反映、フローデフォルト値、対象権限を実接続で検証するまで、この候補を適用しない。

## 検証結果
|検証|結果|実証範囲|
|---|---|---|
|YAML構文|PASS|PyYAMLで候補を解析。Power Apps構文検証ではない|
|既存コントロール保持|PASS|15個保持、S7_Src位置/高さ以外は同一|
|追加UI書込操作|PASS|Patch/SubmitForm/Remove/Flow.Runなし、送信無効固定|
|静的配置|PASS|上記4種類の高さでパネル本文の高さと下部領域を確認|
|既存Form1の変更|なし|MainScreen1差分なし|
|Power Appsバックアップ|未確認|既存手動workflowの読取確認のみ。今回実行なし|
|バックアップ実対象一致/復元|未確認|workflow manifest自体もappIdParityVerified=false、savedSourceComparisonVerified=false|
|App Checker重大0|未確認|PAC CLI未導入、検証ツール未公開。静的YAML成功で代用しない|
|実画面開閉/戻る/キーボード|未実施|レビュー候補未適用|
|実保存/再取得/権限エラー|未実施|本番リストへの試験書込なし|
|通信失敗/連打/重複|未実施|同一試験用環境・データ分離条件が未確定|
|フロー非起動|BLOCKED|実定義の読取経路なし|
|公開可否|BLOCKED|保存済み実ソース比較、バックアップ、App Checker、遷移保存テスト未完了|

既存手動バックアップworkflow .github/workflows/cn-aiiraidaicho-backup-manual.yml はexport/checksum/artifact手順を持つ。
ただし確認したファイル内容は成功実績・復元可能性の証明ではない。GitHub connectorでworkflow一覧/該当手動run一覧のGETはINVALID_ARGUMENTで取得できなかった。現在HEADのPRイベントCIと手動バックアップを混同しない。

## 次工程の必要証跡
1. 実フロー定義を取得し、意見項目の扱いとAI実行/承認条件を確定。
2. 対象App ID/Environment一致の最新バックアップ、チェックサム、読取復元比較。
3. 保存済み実ソースとGitHub候補適用前ソースの一致。
4. 実接続のPerson型・表示名・最大長・投稿権限を確認。
5. 許可された試験範囲で開く→本文入力→戻る→再開、本文空白、連打、失敗時保持、保存成功後再取得、応答不明、既存通常依頼回帰を確認。
6. 同一検証版のApp Checker重大0の結果を取得。

mainマージ・本番更新/保存/公開・フロー実行・既存資産削除・新規アプリ・権限拡大は未実施。
