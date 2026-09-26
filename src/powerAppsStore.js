/**
 * Power Apps管理モジュール - エンタープライズコンパクト版
 */
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

// 上流(Entra ID / Power Apps管理API / Dataverse)の失敗を、秘密値を含めずに
// HTTP status・error code・error message・失敗工程付きのErrorにする。
async function buildUpstreamError(step, response) {
  let code = null;
  let message = null;
  try {
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    const err = body.error && typeof body.error === 'object' ? body.error : body;
    code = err.code || body.error || null;
    message = err.message || body.error_description || null;
  } catch {
    // 本文がJSONでない場合はstatusのみ返す
  }
  if (typeof message === 'string') {
    // トークン/トレースIDなどを返さないよう先頭のみ
    message = message.split(/\r?\n/)[0].slice(0, 300);
  }
  if (typeof code !== 'string') code = code == null ? null : String(code);
  const error = new Error(`${step}に失敗しました (HTTP ${response.status}${code ? `, ${code}` : ''})${message ? `: ${message}` : ''}`);
  error.upstream = { step, httpStatus: response.status, errorCode: code, errorMessage: message };
  error.retryable = response.status === 429 || response.status >= 500;
  return error;
}

class RetryStrategy {
  constructor(maxAttempts = 3, baseDelayMs = 500) {
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
  }

  async execute(fn) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === this.maxAttempts || error.retryable === false) throw error;
        const delay = this.baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

}

class TokenCache {
  constructor() {
    this._token = null;
    this._expiresAt = 0;
  }

  async getToken(fetchFn, tokenUrl, clientId, clientSecret, scope = 'https://service.powerapps.com/.default') {
    const now = Date.now();
    if (this._token && now < this._expiresAt - 60000) return this._token;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope,
      grant_type: 'client_credentials'
    });

    const response = await fetchFn(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!response.ok) throw await buildUpstreamError(`認証トークン取得(${scope})`, response);
    const data = await response.json();
    this._token = data.access_token;
    this._expiresAt = now + data.expires_in * 1000;
    return this._token;
  }

  invalidate() {
    this._token = null;
    this._expiresAt = 0;
  }
}

class ResponseCache {
  constructor(ttlMs = 300000) {
    this._cache = new Map();
    this._ttl = ttlMs;
  }

  get(key) {
    const entry = this._cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    this._cache.set(key, { value, expiresAt: Date.now() + this._ttl });
  }

  invalidate(pattern) {
    if (!pattern) this._cache.clear();
    else for (const key of this._cache.keys()) if (key.includes(pattern)) this._cache.delete(key);
  }
}

class Metrics {
  constructor() {
    this.metrics = { calls: 0, success: 0, failed: 0, totalTime: 0, cacheHits: 0 };
  }

  record(duration, success, cached) {
    this.metrics.calls++;
    if (success) this.metrics.success++;
    else this.metrics.failed++;
    this.metrics.totalTime += duration;
    if (cached) this.metrics.cacheHits++;
  }

  getStats() {
    return {
      ...this.metrics,
      avgTime: this.metrics.calls > 0 ? (this.metrics.totalTime / this.metrics.calls).toFixed(2) : 0,
      successRate: this.metrics.calls > 0 ? ((this.metrics.success / this.metrics.calls) * 100).toFixed(1) + '%' : '0%'
    };
  }
}

class PowerAppsStore {
  constructor(config = {}) {
    this.tenantId = config.tenantId || '';
    this.clientId = config.clientId || '';
    this.clientSecret = config.clientSecret || '';
    this.environmentId = config.environmentId || '';
    this.appId = config.appId || '';
    this.orgUrl = (config.orgUrl || '').replace(/\/$/, '');
    this.logPath = config.logPath || 'data/powerapps-operations.jsonl';
    this.managementApiBaseUrl = config.managementApiBaseUrl || 'https://api.powerapps.com';
    this.tokenUrl = config.tokenUrl || `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    this._fetch = config.fetchImpl || fetch;
    this._tokenCache = new TokenCache();
    this._dataverseTokenCache = new TokenCache();
    this._cache = new ResponseCache(config.cacheTtlMs || 300000);
    this._metrics = new Metrics();
    this._retry = new RetryStrategy();
    // operationId -> logEntry のインメモリ索引（ログファイル全件走査を回避するため）
    this._operationIndex = new Map();
    // appId別の直近ログを保持するリングバッファ（getOperationLogの高速化用）
    this._operationRingCap = config.operationRingCap || 500;
    this._operationRing = [];
  }

  async _managementFetch(path, options = {}) {
    const start = Date.now();
    const token = await this._tokenCache.getToken(this._fetch, this.tokenUrl, this.clientId, this.clientSecret);
    return this._retry.execute(async () => {
      const response = await this._fetch(`${this.managementApiBaseUrl}${path}`, {
        ...options,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) }
      });
      const duration = Date.now() - start;
      if (!response.ok) {
        this._metrics.record(duration, false, false);
        throw await buildUpstreamError('Power Apps管理API呼び出し', response);
      }
      this._metrics.record(duration, true, false);
      return response.status === 204 ? null : response.json();
    });
  }

  async _dataverseFetch(path, options = {}) {
    if (!this.orgUrl) throw new Error('POWERAPPS_ORG_URLが未設定です');
    const start = Date.now();
    const token = await this._dataverseTokenCache.getToken(
      this._fetch,
      this.tokenUrl,
      this.clientId,
      this.clientSecret,
      `${this.orgUrl}/.default`
    );
    return this._retry.execute(async () => {
      const response = await this._fetch(`${this.orgUrl}/api/data/v9.2/${path}`, {
        ...options,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', 'odata-version': '4.0', 'if-none-match': 'null', ...(options.headers || {}) }
      });
      const duration = Date.now() - start;
      if (!response.ok) {
        this._metrics.record(duration, false, false);
        throw await buildUpstreamError('Dataverse API呼び出し', response);
      }
      this._metrics.record(duration, true, false);
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    });
  }

  async _getCanvasRecord() {
    const key = `canvas_${this.appId}`;
    const cached = this._cache.get(key);
    if (cached) {
      this._metrics.record(0, true, true);
      return cached;
    }
    const record = await this._dataverseFetch(
      `canvasapps(${this.appId})?$select=canvasappid,uniquecanvasappid,displayname,description,commitmessage,status,appversion,createdtime,lastmodifiedtime,lastpublishtime,publisher`
    );
    this._cache.set(key, record);
    return record;
  }

  async _getUnmanagedSolutions() {
    const key = `solutions_${this.environmentId}`;
    const cached = this._cache.get(key);
    if (cached) {
      this._metrics.record(0, true, true);
      return cached;
    }
    const data = await this._dataverseFetch(
      'solutions?$select=solutionid,uniquename,friendlyname,version,ismanaged&$filter=ismanaged eq false&$orderby=friendlyname'
    );
    const solutions = (data?.value || []).map((s) => ({
      solutionId: s.solutionid,
      uniqueName: s.uniquename,
      friendlyName: s.friendlyname,
      version: s.version
    }));
    this._cache.set(key, solutions);
    return solutions;
  }

  async _recordOperation(operationId, operation, environmentId, appId, entry) {
    const logEntryObj = {
      timestamp: new Date().toISOString(),
      operationId,
      operation,
      environmentId,
      appId,
      metrics: this._metrics.getStats(),
      ...entry
    };
    // getOperationResult/getOperationLogがファイル全件走査せずに済むよう、
    // メモリ上にも索引・直近ログを保持する（プロセス再起動後はファイルへフォールバック）
    this._operationIndex.set(operationId, logEntryObj);
    this._operationRing.push(logEntryObj);
    if (this._operationRing.length > this._operationRingCap) this._operationRing.shift();
    try {
      await fs.appendFile(this.logPath, `${JSON.stringify(logEntryObj)}\n`, 'utf8');
    } catch (error) {
      console.error('ログ記録失敗', error.message);
    }
  }

  async getAppInfo() {
    const missing = [];
    if (!this.tenantId) missing.push('POWERAPPS_TENANT_ID/AZURE_TENANT_ID');
    if (!this.clientId) missing.push('POWERAPPS_CLIENT_ID/AZURE_CLIENT_ID');
    if (!this.clientSecret) missing.push('POWERAPPS_CLIENT_SECRET/AZURE_CLIENT_SECRET');
    if (!this.environmentId) missing.push('POWERAPPS_ENVIRONMENT_ID');
    if (!this.appId) missing.push('POWERAPPS_APP_ID');
    if (missing.length) {
      const error = new Error(`Bridge設定が不足しています: ${missing.join(', ')}`);
      error.upstream = { step: 'Bridge環境変数の読み込み', httpStatus: null, errorCode: 'ConfigMissing', errorMessage: error.message };
      throw error;
    }
    const path = `/providers/Microsoft.PowerApps/apps/${this.appId}?api-version=2016-11-01`;
    let data;
    try {
      data = await this._managementFetch(path);
    } catch (error) {
      if (!error.upstream) {
        error.upstream = { step: 'Power Apps管理API呼び出し', httpStatus: null, errorCode: error.name || null, errorMessage: String(error.message).slice(0, 300) };
      }
      throw error;
    }
    // Dataverse側の補足情報は取得できなくてもアプリ名・App IDは返す
    let canvas = {};
    let dataverseWarning;
    if (this.orgUrl) {
      try {
        canvas = (await this._getCanvasRecord()) || {};
      } catch (error) {
        dataverseWarning = error.upstream || { step: 'Dataverse API呼び出し', errorMessage: String(error.message).slice(0, 300) };
      }
    }
    return {
      ...(dataverseWarning ? { warning: dataverseWarning } : {}),
      status: 'ok',
      appId: this.appId,
      environmentId: this.environmentId,
      displayName: canvas.displayname || data.properties?.displayName || 'Unknown',
      description: canvas.description || data.properties?.description || null,
      publisher: canvas.publisher || data.properties?.publisher || 'Unknown',
      versionNumber: canvas.appversion || data.properties?.appVersion || null
    };
  }

  async getAppState() {
    if (!this.environmentId || !this.appId) throw new Error('environmentIdおよびappIdが未設定です');
    const operationId = crypto.randomUUID();
    try {
      const path = `/providers/Microsoft.PowerApps/apps/${this.appId}?api-version=2016-11-01`;
      const state = await this._managementFetch(path);
      const canvas = this.orgUrl ? await this._getCanvasRecord() : {};
      const solutions = this.orgUrl ? await this._getUnmanagedSolutions() : [];
      const props = state.properties || {};
      await this._recordOperation(operationId, 'get_state', this.environmentId, this.appId, {
        status: 'success',
        result: { versionNumber: canvas.appversion || props.appVersion || null }
      });
      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        versionNumber: canvas.appversion || props.appVersion || null,
        displayName: canvas.displayname || props.displayName || 'Unknown',
        unmanagedSolutions: solutions
      };
    } catch (error) {
      await this._recordOperation(operationId, 'get_state', this.environmentId, this.appId, { status: 'error', error: error.message });
      throw error;
    }
  }

  async updateApp(updateData) {
    if (!this.environmentId || !this.appId) throw new Error('environmentIdおよびappIdが未設定です');
    if (!updateData || typeof updateData !== 'object') throw new Error('updateDataはオブジェクトが必要です');
    const operationId = crypto.randomUUID();
    try {
      const allowed = new Set(['description', 'commitMessage']);
      const fields = Object.keys(updateData);
      if (!fields.length || fields.some((f) => !allowed.has(f))) throw new Error('編集できるのはdescriptionおよびcommitMessageのみです');
      const current = await this.getAppState();
      const patch = {};
      if (updateData.description) patch.description = updateData.description;
      if (updateData.commitMessage) patch.commitmessage = updateData.commitMessage;
      await this._dataverseFetch(`canvasapps(${this.appId})`, { method: 'PATCH', body: JSON.stringify(patch) });
      this._cache.invalidate(this.appId);
      await this._recordOperation(operationId, 'update', this.environmentId, this.appId, {
        status: 'success',
        changesBefore: { versionNumber: current.versionNumber },
        result: { pendingPublish: true }
      });
      return { status: 'ok', operationId, appId: this.appId, environmentId: this.environmentId, pendingPublish: true };
    } catch (error) {
      await this._recordOperation(operationId, 'update', this.environmentId, this.appId, { status: 'error', error: error.message });
      throw error;
    }
  }

  async saveApp() {
    if (!this.environmentId || !this.appId) throw new Error('environmentIdおよびappIdが未設定です');
    const operationId = crypto.randomUUID();
    try {
      const current = await this.getAppState();
      await this._recordOperation(operationId, 'save', this.environmentId, this.appId, {
        status: 'success',
        result: { versionNumber: current.versionNumber, pendingPublish: true }
      });
      return { status: 'ok', operationId, appId: this.appId, message: '保存済みの変更を確認しました。' };
    } catch (error) {
      await this._recordOperation(operationId, 'save', this.environmentId, this.appId, { status: 'error', error: error.message });
      throw error;
    }
  }

  async publishApp() {
    if (!this.environmentId || !this.appId) throw new Error('environmentIdおよびappIdが未設定です');
    const operationId = crypto.randomUUID();
    try {
      const before = await this.getAppState();
      const path = `/providers/Microsoft.PowerApps/apps/${this.appId}/publish?api-version=2016-11-01`;
      await this._managementFetch(path, { method: 'POST', body: JSON.stringify({ strategy: 'immediate' }) });
      this._cache.invalidate(this.appId);
      await this._recordOperation(operationId, 'publish', this.environmentId, this.appId, {
        status: 'success',
        result: { publishedVersion: before.versionNumber, publishedAt: new Date().toISOString() }
      });
      return { status: 'ok', operationId, appId: this.appId, message: '公開に成功しました。' };
    } catch (error) {
      await this._recordOperation(operationId, 'publish', this.environmentId, this.appId, { status: 'error', error: error.message });
      throw error;
    }
  }

  async getOperationResult(operationId) {
    if (!operationId || typeof operationId !== 'string') throw new Error('operationIdが必要です');
    const cached = this._operationIndex.get(operationId);
    if (cached) {
      return { status: 'ok', operationId, operation: cached.operation, operationStatus: cached.status, result: cached.result, metrics: cached.metrics };
    }
    // プロセス再起動直後などメモリ索引に無い場合のみファイルへフォールバック
    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      for (const line of content.trim().split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        if (entry.operationId === operationId) {
          return { status: 'ok', operationId, operation: entry.operation, operationStatus: entry.status, result: entry.result, metrics: entry.metrics };
        }
      }
      return { status: 'not_found', operationId, message: 'operationIdが見つかりません' };
    } catch (error) {
      throw new Error(`操作結果取得失敗: ${error.message}`);
    }
  }

  async getOperationLog(limit = 50) {
    const inMemory = this._operationRing.filter((entry) => entry.appId === this.appId).slice(-limit).reverse();
    if (inMemory.length >= limit || inMemory.length >= this._operationRing.length) {
      return { status: 'ok', appId: this.appId, count: inMemory.length, operations: inMemory };
    }
    // メモリ上の件数がlimitに満たない場合（再起動直後など）はファイルへフォールバック
    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      const filtered = content.trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.appId === this.appId)
        .reverse()
        .slice(0, limit);
      return { status: 'ok', appId: this.appId, count: filtered.length, operations: filtered };
    } catch (error) {
      throw new Error(`操作ログ取得失敗: ${error.message}`);
    }
  }

  async healthCheck() {
    try {
      const start = Date.now();
      const path = `/providers/Microsoft.PowerApps/apps/${this.appId}?api-version=2016-11-01`;
      await this._managementFetch(path);
      return { status: 'healthy', responseTime: Date.now() - start, timestamp: new Date().toISOString() };
    } catch (error) {
      return { status: 'unhealthy', error: error.message, timestamp: new Date().toISOString() };
    }
  }

  getMetrics() {
    return this._metrics.getStats();
  }

  invalidateAuth() {
    this._tokenCache.invalidate();
    this._dataverseTokenCache.invalidate();
  }
}

module.exports = { PowerAppsStore, TokenCache, RetryStrategy, ResponseCache, Metrics };
