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

  async _graphFetch(path, options = {}) {
    const token = await this._getAccessToken();
    const response = await this._fetch(`${this.graphBaseUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) }
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

  async ensureColumns(params = {}) {
    this._assertConfig();
    const targetSiteId = params.siteId || this.defaultSiteId;
    if (!targetSiteId) throw new Error('SharePoint設定が不足しています: siteId（SHAREPOINT_SITE_ID、またはパラメータsiteIdで指定してください）');
    const targetListId = params.listId || (params.listName ? await this._resolveListId(targetSiteId, params.listName) : null);
    if (!targetListId) throw new Error('listIdまたはlistNameのいずれかが必要です');

    const current = await this._graphFetch(`/sites/${targetSiteId}/lists/${targetListId}/columns?$select=id,name,displayName`);
    const existing = new Set((current.value || []).flatMap((column) => [column.name, column.displayName].filter(Boolean)));
    const created = [];
    const skipped = [];

    for (const column of params.columns || []) {
      if (existing.has(column.name) || existing.has(column.displayName)) {
        skipped.push({ name: column.name, displayName: column.displayName, reason: 'already_exists' });
        continue;
      }
      const definition = {
        name: column.name,
        displayName: column.displayName,
        description: column.description || '',
        required: column.required === true
      };
      if (column.type === 'text') definition.text = { allowMultipleLines: column.multiline === true };
      else if (column.type === 'number') definition.number = { decimalPlaces: column.decimalPlaces ?? 'automatic' };
      else if (column.type === 'dateTime') definition.dateTime = { format: column.format || 'dateTime' };
      else if (column.type === 'boolean') definition.boolean = {};
      else if (column.type === 'choice') definition.choice = { choices: column.choices || [], allowTextEntry: false };
      else throw new Error(`未対応の列型です: ${column.type}`);

      const made = await this._graphFetch(`/sites/${targetSiteId}/lists/${targetListId}/columns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(definition)
      });
      created.push({ id: made.id, name: made.name, displayName: made.displayName });
      existing.add(column.name);
      existing.add(column.displayName);
    }
    return { status: 'ok', siteId: targetSiteId, listId: targetListId, created, skipped };
  }

  // params: { siteId?, listId?, listName? } — SharePoint列定義を読み取り専用で取得する。
  async listColumns(params = {}) {
    this._assertConfig();
    const targetSiteId = params.siteId || this.defaultSiteId;
    if (!targetSiteId) {
      throw new Error('SharePoint設定が不足しています: siteId（SHAREPOINT_SITE_ID、またはパラメータsiteIdで指定してください）');
    }
    const targetListId = params.listId || (params.listName ? await this._resolveListId(targetSiteId, params.listName) : null);
    if (!targetListId) throw new Error('listIdまたはlistNameのいずれかが必要です');

    const data = await this._graphFetch(`/sites/${targetSiteId}/lists/${targetListId}/columns`);
    const columns = (data.value || []).map((column) => {
      const type = ['text', 'number', 'dateTime', 'boolean', 'choice', 'lookup', 'personOrGroup', 'currency', 'hyperlinkOrPicture']
        .find((key) => column[key] !== undefined) || 'unknown';
      return {
        id: column.id,
        name: column.name,
        displayName: column.displayName,
        type,
        required: column.required === true,
        readOnly: column.readOnly === true,
        hidden: column.hidden === true,
        ...(column.choice ? { choices: column.choice.choices || [], allowTextEntry: column.choice.allowTextEntry === true } : {}),
        ...(column.text ? { allowMultipleLines: column.text.allowMultipleLines === true } : {}),
        ...(column.dateTime ? { dateTimeFormat: column.dateTime.format || null } : {})
      };
    });
    return { status: 'ok', siteId: targetSiteId, listId: targetListId, count: columns.length, columns };
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
    const [data, schema] = await Promise.all([
      this._graphFetch(`/sites/${targetSiteId}/lists/${targetListId}/items?expand=fields&$top=${limit}`),
      this.listColumns({ siteId: targetSiteId, listId: targetListId })
    ]);
    const items = (data.value || []).map((item) => ({ itemId: item.id, fields: item.fields || {} }));
    return {
      status: 'ok',
      siteId: targetSiteId,
      listId: targetListId,
      count: items.length,
      items,
      columns: schema.columns
    };
  }
}

module.exports = { SharePointReader };
