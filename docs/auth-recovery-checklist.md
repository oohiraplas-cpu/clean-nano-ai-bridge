# 認証障害（Bridge MAX / CNAI Bridge / OZ Router）復旧チェックリスト

作成根拠: 2026-11-11 の読み取り監査（コード・テスト・GitHub Actions 履歴）。本番の実設定は未確認。
秘密値は表示・記録しない。確認するのは「有無・長さ・名前・設定の状態」だけ。

## A. ユーザー操作が必要（Azure / Copilot Studio の画面）

| # | 対象 | 確認すること | 期待値 | 違った場合 |
|---|---|---|---|---|
| A1 | Copilot Studio「CNAI Bridge」接続 | ヘッダー名 | `X-API-Key` | ヘッダー名を直す |
| A2 | 同上 | 保存した鍵が Azure の `MCP_API_KEY` と同じか | 同じ | 接続の鍵を更新（再作成は承認を得てから） |
| A3 | 同上 | 接続の所有者・有効期限・状態 | 有効 | 所有者で再認証 |
| A4 | Bridge の App Settings | `MCP_API_KEY` が設定済みか（有無と長さのみ） | 設定済み | **#236 をマージする前に設定**（未設定だと /mcp が 503） |
| A5 | OZ Router の Easy Auth | 認証必須か、未認証の扱い、除外パス | `/mcp` が API キーで届く | `/mcp` を除外パスにする、または未認証を許可（APIキーはアプリ側で検証） |
| A6 | OZ Router の App Settings | `OZ_ROUTER_API_KEY` の有無 | 設定済み | 設定 |
| A7 | cn-engineering-mcp の Copilot Studio 接続 | ヘッダー名 | `Authorization: Bearer`（#65 のマージ後は `X-API-Key` も可） | ヘッダー名を合わせる |
| A8 | Entra アプリ登録（使う場合のみ） | クライアントID、テナントID、公開スコープ、許可クライアント | `CN_ENTRA_TENANT_ID` / `CN_ENTRA_AUDIENCE` と一致 | 設定を合わせる |

A4〜A8 の App Settings と Easy Auth は、`auth-diagnose-readonly.yml`（読み取り専用）を実行すると、値を出さずに一覧できる。

## B. ユーザー操作が不要（実施済み）

| # | 内容 | 状態 |
|---|---|---|
| B1 | Bridge `/mcp` を鍵未設定時 503 に（#236） | PR・CI 成功（未マージ） |
| B2 | OZ Router のプリンシパルヘッダーを、Easy Auth 有効時のみ信用（#4） | PR・CI 成功（未マージ） |
| B3 | cn-engineering-mcp で `X-API-Key` を受け付け（#65） | PR・CI 成功（未マージ） |
| B4 | 読み取り専用の診断ワークフロー（#236 に同梱） | 追加済み・未実行 |

## C. マージ・デプロイ（明示の指示が必要）

main へのマージは本番デプロイになる。順序の推奨:
1. A4 を確認 → #236
2. #65（A7 の接続が `X-API-Key` の場合に効く）
3. #4（偽造ヘッダーの遮断。復旧そのものには効かない）

## D. OAuth の resource / scope 不一致（AADSTS9010010）— 2026-11-13 の読み取り確認

本番の `/.well-known/oauth-protected-resource/recovery/mcp`（公開・秘密値なし）を取得した結果:

| 項目 | 値 |
|---|---|
| resource | `https://<bridge host>/recovery/mcp`（HTTPS） |
| scopes_supported | `api://9cb3b23b-aa1a-4a45-a73e-24c78a2c2252/mcp.access`（`api://` 形式） |
| authorization_servers | Entra テナント v2.0 |

- 確認済み: `resource` が HTTPS URL、スコープが `api://` 形式で、Application ID URI の形が一致していない。MCP クライアント（ChatGPT など）は `resource` に MCP URL を送るため、Entra が `AADSTS9010010` を返す条件に当たる。
- 未確認: 実際の失敗リクエスト（`resource` / `scope` / 相関ID）、Entra 側の `identifierUris` と `requestedAccessTokenVersion`。
- コードは変更しない（`src/recoveryOAuth.js` は v1・v2 トークンの両方を検証済み。本番で稼働中の経路のため）。
- 直すのは Entra 側（人間操作 1 件）: リソース側アプリ登録の Application ID URI に `https://<bridge host>` を追加し、`requestedAccessTokenVersion=2`、スコープは `https://<bridge host>/mcp.access` に揃える。そのうえで `RECOVERY_ENTRA_AUDIENCE` と許可オーディエンスの整合を確認する。
- 関連: OZ Router 側は clean-nano-oz-router PR #12（`docs/oauth-resource-alignment.md`）。
