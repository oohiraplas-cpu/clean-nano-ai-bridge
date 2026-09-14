const { NEXT_EXCLUDED_STATUSES, normalizeTask } = require('./taskStore');

const DEFAULT_FIELD_MAP = Object.freeze({
  id: 'TaskId',
  title: 'Title',
  description: 'Description',
  status: 'Status',
  retry_count: 'RetryCount',
  approval_required: 'ApprovalRequired',
  userActionRequired: 'UserActionRequired',
  source: 'Source',
  priority: 'Priority',
  result: 'Result'
});

function toBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

// Reads/writes tasks against a SharePoint list via Microsoft Graph, using an
// Entra app registration (client credentials). Internal list column names are
// configurable because the production list's actual schema isn't known here;
// override via config.fieldMap to match it (see .env.example).
class SharePointTaskStore {
  constructor(config = {}) {
    this.tenantId = config.tenantId;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.siteId = config.siteId;
    this.listId = config.listId;
    this.fieldMap = { ...DEFAULT_FIELD_MAP, ...(config.fieldMap || {}) };
    this.graphBaseUrl = config.graphBaseUrl || 'https://graph.microsoft.com/v1.0';
    this.tokenUrl = config.tokenUrl || `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    this._fetch = config.fetchImpl || fetch;
    this._token = null;
    this._tokenExpiresAt = 0;
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

  _toTask(item) {
    const fields = item.fields || {};
    const task = {};
    for (const [key, column] of Object.entries(this.fieldMap)) {
      if (fields[column] === undefined) continue;
      task[key] = fields[column];
    }
    if (task.retry_count !== undefined) task.retry_count = Number(task.retry_count);
    if (task.approval_required !== undefined) task.approval_required = toBoolean(task.approval_required);
    if (task.userActionRequired !== undefined) task.userActionRequired = toBoolean(task.userActionRequired);
    return normalizeTask(task);
  }

  _toFields(task) {
    const fields = {};
    for (const [key, column] of Object.entries(this.fieldMap)) {
      if (task[key] === undefined) continue;
      fields[column] = task[key];
    }
    return fields;
  }

  async _listItems() {
    const data = await this._graphFetch(`/sites/${this.siteId}/lists/${this.listId}/items?expand=fields&$top=999`);
    return (data.value || []).map((item) => ({ itemId: item.id, task: this._toTask(item) }));
  }

  async list() {
    const items = await this._listItems();
    return items.map((entry) => entry.task);
  }

  async upsert(task) {
    const items = await this._listItems();
    const existing = items.find((entry) => entry.task.id === task.id);
    const normalized = normalizeTask(existing ? { ...existing.task, ...task } : task);
    const fields = this._toFields(normalized);
    if (existing) {
      await this._graphFetch(`/sites/${this.siteId}/lists/${this.listId}/items/${existing.itemId}/fields`, {
        method: 'PATCH', body: JSON.stringify(fields)
      });
    } else {
      await this._graphFetch(`/sites/${this.siteId}/lists/${this.listId}/items`, {
        method: 'POST', body: JSON.stringify({ fields })
      });
    }
    return normalized;
  }

  async update(id, patch) {
    const items = await this._listItems();
    const existing = items.find((entry) => entry.task.id === id);
    if (!existing) return null;
    const normalized = normalizeTask({ ...existing.task, ...patch, id });
    const fields = this._toFields(normalized);
    await this._graphFetch(`/sites/${this.siteId}/lists/${this.listId}/items/${existing.itemId}/fields`, {
      method: 'PATCH', body: JSON.stringify(fields)
    });
    return normalized;
  }

  async next() {
    const tasks = await this.list();
    return tasks.find((task) => !NEXT_EXCLUDED_STATUSES.has(task.status)) || null;
  }
}

module.exports = { DEFAULT_FIELD_MAP, SharePointTaskStore };
