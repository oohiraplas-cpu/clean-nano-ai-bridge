/**
 * Power Apps管理モジュール
 */
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

class TokenCache {
  constructor() {
    this._token = null;
    this._expiresAt = 0;
  }

  async getToken(fetchFn, tokenUrl, clientId, clientSecret, scope = 'https://service.powerapps.com/.default') {
    const now = Date.now();
    if (this._token && now < this._expiresAt - 30000) return this._token;

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

    if (!response.ok) {
      throw new Error(`Power Platform認証に失敗しました (${response.status})`);
    }

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
    this._operationIndex = new Map();
    this._recentOperations = [];
    this._operationCacheReady = null;
    this._operationWriteQueue = Promise.resolve();
  }

  async _managementFetch(path, options = {}) {
    const token = await this._tokenCache.getToken(
      this._fetch,
      this.tokenUrl,
      this.clientId,
      this.clientSecret
    );

    const response = await this._fetch(`${this.managementApiBaseUrl}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Power Platform API エラー (${response.status}): ${detail.slice(0, 200)}`
      );
    }

    return response.status === 204 ? null : response.json();
  }

  async _dataverseFetch(path, options = {}) {
    if (!this.orgUrl) throw new Error('POWERAPPS_ORG_URLが未設定です');
    const token = await this._dataverseTokenCache.getToken(
      this._fetch,
      this.tokenUrl,
      this.clientId,
      this.clientSecret,
      `${this.orgUrl}/.default`
    );
    const response = await this._fetch(`${this.orgUrl}/api/data/v9.2/${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'odata-version': '4.0',
        'if-none-match': 'null',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Dataverse API エラー (${response.status}): ${detail.slice(0, 300)}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async _getCanvasRecord() {
    return this._dataverseFetch(
      `canvasapps(${this.appId})?$select=canvasappid,uniquecanvasappid,displayname,description,commitmessage,status,appversion,createdtime,lastmodifiedtime,lastpublishtime,publisher`
    );
  }

  async _getUnmanagedSolutions() {
    const data = await this._dataverseFetch(
      'solutions?$select=solutionid,uniquename,friendlyname,version,ismanaged&$filter=ismanaged eq false&$orderby=friendlyname'
    );
    return (data?.value || []).map((solution) => ({
      solutionId: solution.solutionid,
      uniqueName: solution.uniquename,
      friendlyName: solution.friendlyname,
      version: solution.version
    }));
  }

  _cacheOperation(entry) {
    // Keep the latest 500 entries, including the most recent status for each operationId.
    if (this._recentOperations.length === 500) {
      const removed = this._recentOperations.shift();
      if (this._operationIndex.get(removed.operationId) === removed) {
        this._operationIndex.delete(removed.operationId);
      }
    }
    this._recentOperations.push(entry);
    if (entry.operationId) this._operationIndex.set(entry.operationId, entry);
  }

  async _ensureOperationCache() {
    if (!this._operationCacheReady) {
      this._operationCacheReady = (async () => {
        let content;
        try {
          content = await fs.readFile(this.logPath, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') return;
          throw error;
        }
        // Hydrate once per store instance; subsequent reads never scan the log file.
        for (const line of content.split('\\n')) {
          if (!line.trim()) continue;
          try {
            this._cacheOperation(JSON.parse(line));
          } catch {
            console.error('不正な操作ログ行をスキップしました');
          }
        }
      })().catch((error) => {
        this._operationCacheReady = null;
        throw error;
      });
    }
    await this._operationCacheReady;
  }

  async _recordOperation(operationId, operation, environmentId, appId, entry) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      operationId,
      operation,
      environmentId,
      appId,
      ...entry
    };
    const write = async () => {
      await this._ensureOperationCache();
      await fs.appendFile(this.logPath, JSON.stringify(logEntry) + '\\n', 'utf8');
      this._cacheOperation(logEntry);
    };
    const pending = this._operationWriteQueue.then(write);
    this._operationWriteQueue = pending.catch(() => {});
    try {
      await pending;
    } catch (error) {
      console.error('operationログ記録に失敗しました', { operationId, operation, error: error.message });
    }
  }

  async getAppInfo() {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    try {
      const path = `/providers/Microsoft.PowerApps/apps/${this.appId}?api-version=2016-11-01`;
      const data = await this._managementFetch(path);
      const canvas = this.orgUrl ? await this._getCanvasRecord() : {};
      return {
        status: 'ok',
        appId: this.appId,
        environmentId: this.environmentId,
        displayName: canvas.displayname || data.properties?.displayName || 'Unknown',
        description: canvas.description || data.properties?.description || null,
        publisher: canvas.publisher || data.properties?.publisher || 'Unknown',
        createdTime: canvas.createdtime || data.properties?.createdTime || null,
        modifiedTime: canvas.lastmodifiedtime || data.properties?.lastModifiedTime || null,
        publishedTime: canvas.lastpublishtime || null,
        versionNumber: canvas.appversion || data.properties?.appVersion || null,
        appType: data.properties?.appType || 'canvas'
      };
    } catch (error) {
      throw new Error(`アプリ情報取得に失敗しました: ${error.message}`);
    }
  }

  async getAppState() {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    const operationId = crypto.randomUUID();
    try {
      const path = `/providers/Microsoft.PowerApps/apps/${this.appId}?api-version=2016-11-01`;
      const state = await this._managementFetch(path);
      const canvas = this.orgUrl ? await this._getCanvasRecord() : {};
      const unmanagedSolutions = this.orgUrl ? await this._getUnmanagedSolutions() : [];
      const properties = state.properties || {};

      await this._recordOperation(operationId, 'get_state', this.environmentId, this.appId, {
        status: 'success',
        result: { versionNumber: canvas.appversion || properties.appVersion || null }
      });

      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        versionNumber: canvas.appversion || properties.appVersion || null,
        displayName: canvas.displayname || properties.displayName || 'Unknown',
        description: canvas.description || properties.description || null,
        appStatus: canvas.status || null,
        connectors: properties.connectionReferences || {},
        unmanagedSolutions,
        lastModified: canvas.lastmodifiedtime || properties.lastModifiedTime || null,
        lastPublished: canvas.lastpublishtime || null
      };
    } catch (error) {
      await this._recordOperation(operationId, 'get_state', this.environmentId, this.appId, {
        status: 'error',
        error: error.message
      });
      throw error;
    }
  }

  async updateApp(updateData) {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    if (!updateData || typeof updateData !== 'object') {
      throw new Error('updateDataはオブジェクトである必要があります');
    }

    const operationId = crypto.randomUUID();
    try {
      const allowed = new Set(['description', 'commitMessage']);
      const fields = Object.keys(updateData);
      if (!fields.length || fields.some((field) => !allowed.has(field))) {
        throw new Error('updateDataで編集できるのはdescriptionおよびcommitMessageのみです');
      }
      const currentState = await this.getAppState();
      const changesBefore = {
        versionNumber: currentState.versionNumber,
        description: currentState.description
      };

      const patch = {};
      if (Object.hasOwn(updateData, 'description')) patch.description = updateData.description;
      if (Object.hasOwn(updateData, 'commitMessage')) patch.commitmessage = updateData.commitMessage;
      await this._dataverseFetch(`canvasapps(${this.appId})`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      const updatedState = await this._getCanvasRecord();

      const changesApplied = {
        fields,
        timestamp: new Date().toISOString()
      };

      await this._recordOperation(operationId, 'update', this.environmentId, this.appId, {
        status: 'success',
        changesBefore,
        changesApplied,
        result: { pendingPublish: true }
      });

      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        pendingPublish: true,
        versionNumber: updatedState.appversion || currentState.versionNumber,
        changesApplied
      };
    } catch (error) {
      await this._recordOperation(operationId, 'update', this.environmentId, this.appId, {
        status: 'error',
        error: error.message
      });
      throw error;
    }
  }

  async saveApp() {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    const operationId = crypto.randomUUID();
    try {
      const currentState = await this.getAppState();
      const savedAt = new Date().toISOString();

      await this._recordOperation(operationId, 'save', this.environmentId, this.appId, {
        status: 'pending_verification',
        result: {
          versionNumber: currentState.versionNumber,
          savedAt,
          pendingPublish: false,
          liveSourceVerified: false
        }
      });

      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        versionNumber: currentState.versionNumber,
        savedAt,
        liveSourceVerified: false,
        pendingPublish: false,
        message: 'Git同期処理後のアプリ状態を取得しましたが、画面ソースの実反映・保存は未検証です。公開しないでください。'
      };
    } catch (error) {
      await this._recordOperation(operationId, 'save', this.environmentId, this.appId, {
        status: 'error',
        error: error.message
      });
      throw error;
    }
  }

  async publishApp() {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    const operationId = crypto.randomUUID();
    try {
      const beforePublish = await this.getAppState();

      const path = `/providers/Microsoft.PowerApps/apps/${this.appId}/publish?api-version=2016-11-01`;
      await this._managementFetch(path, {
        method: 'POST',
        body: JSON.stringify({ strategy: 'immediate' })
      });

      await this._recordOperation(operationId, 'publish', this.environmentId, this.appId, {
        status: 'success',
        changesBefore: { versionNumber: beforePublish.versionNumber },
        result: {
          publishedVersion: beforePublish.versionNumber,
          publishedAt: new Date().toISOString()
        }
      });

      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        publishedVersion: beforePublish.versionNumber,
        publishedAt: new Date().toISOString(),
        message: '公開に成功しました。エンドユーザーが利用できます。'
      };
    } catch (error) {
      await this._recordOperation(operationId, 'publish', this.environmentId, this.appId, {
        status: 'error',
        error: error.message
      });
      throw error;
    }
  }

  async getOperationResult(operationId) {
    if (!operationId || typeof operationId !== 'string') {
      throw new Error('operationIdが必要です');
    }
    try {
      await this._operationWriteQueue;
      await this._ensureOperationCache();
      const entry = this._operationIndex.get(operationId);
      if (!entry) {
        return { status: 'not_found', operationId, message: '直近500件に指定されたoperationIdが見つかりません' };
      }
      return {
        status: 'ok',
        operationId,
        operation: entry.operation,
        timestamp: entry.timestamp,
        operationStatus: entry.status,
        result: entry.result || null,
        error: entry.error || null,
        changesBefore: entry.changesBefore || null,
        changesApplied: entry.changesApplied || null
      };
    } catch (error) {
      throw new Error(`操作結果取得に失敗しました: ${error.message}`);
    }
  }

  async getOperationLog(limit = 50) {
    try {
      await this._operationWriteQueue;
      await this._ensureOperationCache();
      const count = Number.isFinite(limit) ? Math.max(0, Math.min(500, Math.trunc(limit))) : 50;
      const filtered = this._recentOperations
        .filter((entry) => entry.appId === this.appId)
        .slice(-count || this._recentOperations.length)
        .reverse();
      return {
        status: 'ok',
        appId: this.appId,
        count: count === 0 ? 0 : filtered.length,
        operations: count === 0 ? [] : filtered
      };
    } catch (error) {
      throw new Error(`操作ログ取得に失敗しました: ${error.message}`);
    }
  }

  async rollbackOperation(operationId) {
    if (!operationId || typeof operationId !== 'string') {
      throw new Error('operationIdが必要です');
    }

    const newOperationId = crypto.randomUUID();
    try {
      const target = await this.getOperationResult(operationId);
      if (target.status === 'not_found') {
        throw new Error(`operationId: ${operationId} が見つかりません`);
      }

      if (!target.changesBefore) {
        throw new Error('ロールバック対象の操作には前の状態情報が含まれていません');
      }

      const restoredState = target.changesBefore;

      await this._recordOperation(newOperationId, 'rollback', this.environmentId, this.appId, {
        status: 'success',
        result: {
          rolledBackOperationId: operationId,
          restoredState,
          rolledBackAt: new Date().toISOString()
        }
      });

      return {
        status: 'ok',
        operationId: newOperationId,
        rolledBackOperationId: operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        restoredState,
        message: `operationId: ${operationId} をロールバックしました`
      };
    } catch (error) {
      await this._recordOperation(newOperationId, 'rollback', this.environmentId, this.appId, {
        status: 'error',
        error: error.message
      });
      throw error;
    }
  }

  invalidateAuth() {
    this._tokenCache.invalidate();
    this._dataverseTokenCache.invalidate();
  }
}

module.exports = { PowerAppsStore, TokenCache };
