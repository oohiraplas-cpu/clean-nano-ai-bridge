// Microsoft Graph経由でSharePointリストの項目を読み取り専用で取得するクラス。
// 既存のSharePointTaskStore（タスク専用・fieldMap固定・list/upsert/update/next）とは
// 目的も呼び出し方も異なるため独立させており、既存の動作中コードには一切手を加えない。
// 認証はSharePointTaskStoreと同じくEntraアプリ登録のクライアントクレデンシャルフロー
// （SHAREPOINT_TENANT_ID / SHAREPOINT_CLIENT_ID / SHAREPOINT_CLIENT_SECRET）を再利用する。
class SharePointReader {
  constructor(config = {}) {
    this.tenantId = config.tenantId || '';
    this.clientId = config.clientId || '';
    this.clientSecret = config.clientSecret || '';
    this.defaultSiteId = config.siteId || '';
    this.graphBaseUrl = config.graphBaseUrl || 'https://graph.microsoft.com/v1.0';
    this.tokenUrl = config.tokenUrl || `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    this._fetch = config.fetchImpl || fetch;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  _assertConfig() {
    const missingEnvNames = [];
    if (!this.tenantId) missingEnvNames.push('SHAREPOINT_TENANT_ID');
    if (!this.clientId) missingEnvNames.push('SHAREPOINT_CLIENT_ID');
    if (!this.clientSecret) missingEnvNames.push('SHAREPOINT_CLIENT_SECRET');
    if (missingEnvNames.length) {
      throw new Error(`SharePoint設定が不足しています: ${missingEnvNames.join(', ')}`);
    }
  }

  async _getAccessToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpiresAt - 30000) return this._token;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    });
    const response = await this._fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!response.ok) throw new Error(`SharePoint認証に失敗しました (${response.status})`);
    const data = await response.json();
    this._token = data.access_token;
    this._tokenExpiresAt = now + data.expires_in * 1000;
    return this._token;
  }

  async _graphFetch(path) {
    const token = await this._getAccessToken();
    const response = await this._fetch(`${this.graphBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SharePoint Graph APIエラー (${response.status}): ${detail.slice(0, 200)}`);
    }
    return response.json();
  }

  async _resolveListId(siteId, listName) {
    const filter = `displayName eq '${listName.replace(/'/g, "''")}'`;
    const data = await this._graphFetch(`/sites/${siteId}/lists?$select=id,displayName&$filter=${encodeURIComponent(filter)}`);
    const match = (data.value || [])[0];
    if (!match) throw new Error(`指定されたSharePointリストが見つかりません: ${listName}`);
    return match.id;
  }

  // params: { siteId?, listId?, listName?, top? } — listIdまたはlistNameのいずれかが必要。
  // 読み取り専用（作成・更新・削除は行わない）。
  async listItems(params = {}) {
    this._assertConfig();
    const targetSiteId = params.siteId || this.defaultSiteId;
    if (!targetSiteId) {
      throw new Error('SharePoint設定が不足しています: siteId（SHAREPOINT_SITE_ID、またはパラメータsiteIdで指定してください）');
    }
    const targetListId = params.listId || (params.listName ? await this._resolveListId(targetSiteId, params.listName) : null);
    if (!targetListId) throw new Error('listIdまたはlistNameのいずれかが必要です');
    const limit = Math.min(Math.max(Number.parseInt(params.top, 10) || 50, 1), 200);
    const data = await this._graphFetch(`/sites/${targetSiteId}/lists/${targetListId}/items?expand=fields&$top=${limit}`);
    const items = (data.value || []).map((item) => ({ itemId: item.id, fields: item.fields || {} }));
    return { status: 'ok', siteId: targetSiteId, listId: targetListId, count: items.length, items };
  }
}

module.exports = { SharePointReader };
