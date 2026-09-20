// Microsoft Graph経由でSharePointリストの項目を作成・更新するクラス。
// 既存のSharePointReader（読み取り専用・fieldMap無し）やSharePointTaskStore
// （タスク専用・fieldMap固定）とは目的も呼び出し方も異なるため独立させており、
// 既存の動作中コードには一切手を加えない。
// 認証は他のSharePoint連携クラスと同じくEntraアプリ登録のクライアントクレデンシャル
// フロー（SHAREPOINT_TENANT_ID / SHAREPOINT_CLIENT_ID / SHAREPOINT_CLIENT_SECRET）
// を再利用する。
//
// 方針・制約:
// - 作成（POST）・更新（PATCH）のみを提供する。削除APIは提供しない。
// - 列内部名は推測しない。呼び出し側がconfig.fieldMap（キー=業務用の名前、
//   値=SharePoint列の内部名）を明示的に渡すこと。このファイルはCN_社員台帳について
//   実環境（SharePointの「リストの設定」画面）で確認済みの内部名を
//   CN_EMPLOYEE_LEDGER_FIELD_MAPとしてエクスポートするが、他のリストに使う場合は
//   同様に実環境で確認したfieldMapを渡すこと。
// - AI単独でSharePointへの書き込みを確定してはならない。createItem/updateItemの
//   呼び出しは、人間の承認が済んだ後にAPI層（呼び出し元）から行うこと。このクラス
//   自体は承認判定を行わない。

class SharePointListWriter {
  constructor(config = {}) {
    this.tenantId = config.tenantId || '';
    this.clientId = config.clientId || '';
    this.clientSecret = config.clientSecret || '';
    this.graphBaseUrl = config.graphBaseUrl || 'https://graph.microsoft.com/v1.0';
    this.tokenUrl = config.tokenUrl || `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    this.fieldMap = { ...(config.fieldMap || {}) };
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
    if (!this.fieldMap || Object.keys(this.fieldMap).length === 0) {
      throw new Error('fieldMapが指定されていません。列内部名を推測せず、実環境で確認した値をconfig.fieldMapで渡してください。');
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
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SharePoint Graph APIエラー (${response.status}): ${detail.slice(0, 200)}`);
    }
    return response.status === 204 ? null : response.json();
  }

  // record: { 業務キー: 値, ... }。fieldMapに存在しないキーは無視する（未知の列への
  // 誤書き込みを防ぐため）。
  _toFields(record = {}) {
    const fields = {};
    for (const [key, column] of Object.entries(this.fieldMap)) {
      if (record[key] === undefined) continue;
      fields[column] = record[key];
    }
    return fields;
  }

  // 新規アイテムを作成する。戻り値はGraphが返した作成済みアイテム。
  async createItem(siteId, listId, record) {
    this._assertConfig();
    if (!siteId || !listId) throw new Error('siteIdとlistIdは必須です');
    const fields = this._toFields(record);
    if (Object.keys(fields).length === 0) {
      throw new Error('fieldMapに一致する項目がありません（recordのキーを確認してください）');
    }
    return this._graphFetch(`/sites/${siteId}/lists/${listId}/items`, {
      method: 'POST',
      body: JSON.stringify({ fields })
    });
  }

  // 既存アイテムを部分更新する（PATCH）。record内でfieldMapに一致したキーのみ送信する。
  async updateItem(siteId, listId, itemId, record) {
    this._assertConfig();
    if (!siteId || !listId || !itemId) throw new Error('siteId・listId・itemIdは必須です');
    const fields = this._toFields(record);
    if (Object.keys(fields).length === 0) {
      throw new Error('fieldMapに一致する項目がありません（recordのキーを確認してください）');
    }
    await this._graphFetch(`/sites/${siteId}/lists/${listId}/items/${itemId}/fields`, {
      method: 'PATCH',
      body: JSON.stringify(fields)
    });
    return { itemId, updatedFields: fields };
  }
}

// CN_社員台帳の列内部名（2026-09-20にSharePoint「リストの設定」画面で実環境確認済み。
// 推測値ではない）。Modified/Created/Author/EditorはSharePoint標準列のため含めていない
// （書き込み対象外）。
const CN_EMPLOYEE_LEDGER_FIELD_MAP = Object.freeze({
  name: 'Title',
  employeeId: 'EmployeeID',
  progressStatus: 'ProgressStatus',
  department: 'Department',
  employmentStatus: 'EmploymentStatus',
  hireDate: 'HireDate',
  remarks: 'Remarks'
});

module.exports = { SharePointListWriter, CN_EMPLOYEE_LEDGER_FIELD_MAP };
