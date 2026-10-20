const crypto = require('crypto');

// CN_AI依頼台帳への書き込み・取得。
// - 列の内部名は推測しない。config.fieldMap に明示された列だけを使う。
//   必須の論理項目が未設定なら書き込みを拒否する（fail-closed）。
// - 削除は実装しない。
// - 成功は「書き込み後に再取得して内容が一致した」場合のみ verified=true とする。
// - 認証は既存の SharePointTaskStore と同じ Entra アプリ（client credentials）。

const REQUIRED_LOGICAL_FIELDS = Object.freeze(['title', 'status', 'auditId']);
const UPDATABLE_LOGICAL_FIELDS = Object.freeze(['title', 'description', 'assignee', 'status', 'dueDate']);

class RequestLedgerError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'RequestLedgerError';
    this.code = code;
    this.detail = detail || null;
  }
}

class RequestLedgerStore {
  constructor(config = {}) {
    this.tenantId = config.tenantId;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.siteId = config.siteId;
    this.listId = config.listId;
    this.fieldMap = { ...(config.fieldMap || {}) };
    this.graphBaseUrl = config.graphBaseUrl || 'https://graph.microsoft.com/v1.0';
    this.tokenUrl = config.tokenUrl || `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    this._fetch = config.fetchImpl || fetch;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  // 設定が揃っているか。揃っていなければ書き込みは行わない。
  checkConfiguration() {
    const missing = [];
    if (!this.siteId) missing.push('siteId');
    if (!this.listId) missing.push('listId');
    for (const key of REQUIRED_LOGICAL_FIELDS) {
      if (!this.fieldMap[key]) missing.push(`fieldMap.${key}`);
    }
    return { configured: missing.length === 0, missing };
  }

  _assertConfigured() {
    const { configured, missing } = this.checkConfiguration();
    if (!configured) {
      throw new RequestLedgerError('NOT_CONFIGURED', '依頼台帳の設定が不足しているため、処理を停止しました', { missing });
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
    if (!response.ok) {
      throw new RequestLedgerError('AUTH_FAILED', 'SharePoint認証に失敗しました', { status: response.status });
    }
    const data = await response.json();
    this._token = data.access_token;
    this._tokenExpiresAt = now + data.expires_in * 1000;
    return this._token;
  }

  async _graphFetch(path, options = {}) {
    const token = await this._getAccessToken();
    const response = await this._fetch(`${this.graphBaseUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new RequestLedgerError('UPSTREAM_ERROR', 'SharePoint Graph APIがエラーを返しました', {
        status: response.status,
        body: text.slice(0, 200)
      });
    }
    return response.status === 204 ? null : response.json();
  }

  // 論理項目 → 内部列名への変換。未設定の論理項目は含めない。
  _toColumns(logical) {
    const columns = {};
    for (const [key, value] of Object.entries(logical)) {
      const column = this.fieldMap[key];
      if (!column) {
        throw new RequestLedgerError('UNMAPPED_FIELD', `列が未設定の項目があります: ${key}`, { field: key });
      }
      columns[column] = value;
    }
    return columns;
  }

  _toLogical(item) {
    const fields = item.fields || {};
    const result = { itemId: item.id };
    for (const [key, column] of Object.entries(this.fieldMap)) {
      if (fields[column] !== undefined) result[key] = fields[column];
    }
    return result;
  }

  _newAuditId() {
    return `CNAI-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID()}`;
  }

  async createRequest(input = {}) {
    this._assertConfigured();
    const title = String(input.title || '').trim();
    if (!title) throw new RequestLedgerError('VALIDATION', '依頼名（title）が必要です');
    const auditId = this._newAuditId();
    const logical = {
      title,
      status: input.status || '未着手',
      auditId,
      ...(input.description !== undefined ? { description: String(input.description) } : {}),
      ...(input.assignee !== undefined ? { assignee: String(input.assignee) } : {}),
      ...(input.dueDate !== undefined ? { dueDate: String(input.dueDate) } : {})
    };
    const created = await this._graphFetch(`/sites/${this.siteId}/lists/${this.listId}/items`, {
      method: 'POST',
      body: JSON.stringify({ fields: this._toColumns(logical) })
    });
    const itemId = created.id;
    // 書き込み後に再取得して、送った内容が保存されたかを確認する。
    const readBack = await this.getRequest(itemId);
    const mismatches = Object.keys(logical).filter((key) => String(readBack[key]) !== String(logical[key]));
    if (mismatches.length > 0) {
      throw new RequestLedgerError('VERIFY_FAILED', '登録後の内容が一致しませんでした', { itemId, mismatches });
    }
    return { verified: true, itemId, auditId, request: readBack };
  }

  async getRequest(itemId) {
    this._assertConfigured();
    if (!itemId) throw new RequestLedgerError('VALIDATION', 'itemId が必要です');
    const item = await this._graphFetch(
      `/sites/${this.siteId}/lists/${this.listId}/items/${encodeURIComponent(String(itemId))}?expand=fields`
    );
    return this._toLogical(item);
  }

  // 許可された項目のみ更新する。削除や監査IDの変更はできない。
  async updateRequest(itemId, changes = {}) {
    this._assertConfigured();
    if (!itemId) throw new RequestLedgerError('VALIDATION', 'itemId が必要です');
    const keys = Object.keys(changes);
    if (keys.length === 0) throw new RequestLedgerError('VALIDATION', '更新する項目がありません');
    const forbidden = keys.filter((key) => !UPDATABLE_LOGICAL_FIELDS.includes(key));
    if (forbidden.length > 0) {
      throw new RequestLedgerError('FORBIDDEN_FIELD', '更新が許可されていない項目があります', { fields: forbidden });
    }
    const logical = {};
    for (const key of keys) logical[key] = String(changes[key]);
    await this._graphFetch(
      `/sites/${this.siteId}/lists/${this.listId}/items/${encodeURIComponent(String(itemId))}/fields`,
      { method: 'PATCH', body: JSON.stringify(this._toColumns(logical)) }
    );
    const readBack = await this.getRequest(itemId);
    const mismatches = keys.filter((key) => String(readBack[key]) !== logical[key]);
    if (mismatches.length > 0) {
      throw new RequestLedgerError('VERIFY_FAILED', '更新後の内容が一致しませんでした', { itemId, mismatches });
    }
    return { verified: true, itemId, request: readBack };
  }
}

module.exports = { RequestLedgerStore, RequestLedgerError, REQUIRED_LOGICAL_FIELDS, UPDATABLE_LOGICAL_FIELDS };
