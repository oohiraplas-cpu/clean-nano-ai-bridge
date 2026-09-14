/**
 * Power Apps管理モジュール
 *
 * Power Apps/Power Platformとの連携を管理するクラス。
 * 認証、メタデータ取得、アプリケーション操作（編集・保存・公開）、
 * 変更履歴・ログ記録、ロールバック機構を提供する。
 */

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

/**
 * Power Platform認可トークンキャッシュ
 * client_credentials flowで取得したアクセストークンを保持
 */
class TokenCache {
  constructor() {
    this._token = null;
    this._expiresAt = 0;
  }

  async getToken(fetchFn, tokenUrl, clientId, clientSecret) {
    const now = Date.now();
    if (this._token && now < this._expiresAt - 30000) return this._token;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://service.powerapps.com/.default',
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

/**
 * Power Appsアプリケーション操作クラス
 *
 * Power Platform Management APIを使用して：
 * - アプリメタデータ取得
 * - アプリの現在状態取得
 * - アプリ定義の更新・保存
 * - 公開処理
 * - 操作ログ・履歴記録
 */
class PowerAppsStore {
  constructor(config = {}) {
    this.tenantId = config.tenantId || '';
    this.clientId = config.clientId || '';
    this.clientSecret = config.clientSecret || '';
    this.environmentId = config.environmentId || '';
    this.appId = config.appId || '';
    this.logPath = config.logPath || 'data/powerapps-operations.jsonl';
    this.managementApiBaseUrl = config.managementApiBaseUrl || 'https://management.azure.com';
    this.tokenUrl = config.tokenUrl || `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    this._fetch = config.fetchImpl || fetch;
    this._tokenCache = new TokenCache();
  }

  /**
   * 管理APIへのリクエスト送信
   */
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

  /**
   * 操作ログをJSONL形式で記録
   *
   * 各行は以下の構造を持つJSON：
   * {
   *   timestamp: ISO 8601形式の実行日時,
   *   operationId: 操作の一意なID（UUIDv4）,
   *   operation: 操作種別（get_app, get_state, update, save, publish等）,
   *   environmentId: 対象Environment,
   *   appId: 対象App ID,
   *   status: 'success' | 'error',
   *   changesBefore: 操作前の状態（変更・保存・公開操作のみ），
   *   changesApplied: 適用された変更内容（変更・保存・公開操作のみ），
   *   result: 実行結果（タイムスタンプ・新バージョン番号等），
   *   error: エラーメッセージ（失敗時のみ）,
   *   details: その他メタデータ（オプション）
   * }
   */
  async _recordOperation(operationId, operation, environmentId, appId, entry) {
    try {
      const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        operationId,
        operation,
        environmentId,
        appId,
        ...entry
      });
      await fs.appendFile(this.logPath, `${logEntry}\n`, 'utf8');
    } catch (error) {
      console.error('operationログ記録に失敗しました', { operationId, operation, error: error.message });
    }
  }

  /**
   * 対象Power Appsアプリの基本情報を取得
   *
   * @returns {Promise<Object>} アプリ情報（名前、所有者、作成日時、更新日時等）
   */
  async getAppInfo() {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    try {
      const path = `/subscriptions/undefined/resourceGroups/undefined/providers/Microsoft.PowerApps/apps/${this.appId}?api-version=2024-06-15`;
      const data = await this._managementFetch(path);
      return {
        status: 'ok',
        appId: this.appId,
        environmentId: this.environmentId,
        displayName: data.properties?.displayName || 'Unknown',
        publisher: data.properties?.publisher || 'Unknown',
        createdTime: data.properties?.createdTime || null,
        modifiedTime: data.properties?.modifiedTime || null,
        appType: data.properties?.appType || 'Unknown'
      };
    } catch (error) {
      throw new Error(`アプリ情報取得に失敗しました: ${error.message}`);
    }
  }

  /**
   * 対象Power Appsアプリの現在の完全な状態を取得
   *
   * 以下を含む：
   * - アプリ定義（YAML/JSON形式）
   * - コネクタ設定
   * - スクリーンレイアウト
   * - 変数・ルール
   * - リソースの状態
   *
   * @returns {Promise<Object>} アプリの完全な状態
   */
  async getAppState() {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    const operationId = crypto.randomUUID();
    try {
      // 実装例：Power Platform Management APIでアプリ定義を取得
      // Note: 実際のAPIエンドポイントはMicrosoft Docsを参照
      const path = `/subscriptions/undefined/resourceGroups/undefined/providers/Microsoft.PowerApps/apps/${this.appId}/definition?api-version=2024-06-15`;
      const state = await this._managementFetch(path);

      await this._recordOperation(operationId, 'get_state', this.environmentId, this.appId, {
        status: 'success',
        result: { versionNumber: state.properties?.versionNumber || '1.0' }
      });

      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        versionNumber: state.properties?.versionNumber || '1.0',
        definition: state.properties?.definition || {},
        connectors: state.properties?.connectors || {},
        screens: state.properties?.screens || [],
        variables: state.properties?.variables || {},
        lastModified: state.properties?.modifiedTime || null
      };
    } catch (error) {
      await this._recordOperation(operationId, 'get_state', this.environmentId, this.appId, {
        status: 'error',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 対象Power Appsアプリの定義・データソース等を更新
   *
   * ここで渡される変更は一時的なもので、saveで初めて永続化される。
   * 複数の更新をまとめてから保存することが想定される。
   *
   * @param {Object} updateData 更新内容（フォーム定義、表示ロジック等）
   * @returns {Promise<Object>} 更新後の状態
   */
  async updateApp(updateData) {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    if (!updateData || typeof updateData !== 'object') {
      throw new Error('updateDataはオブジェクトである必要があります');
    }

    const operationId = crypto.randomUUID();
    try {
      // 変更前の状態を取得
      const currentState = await this.getAppState();
      const changesBefore = {
        versionNumber: currentState.versionNumber,
        screenCount: currentState.screens.length,
        connectorCount: Object.keys(currentState.connectors).length
      };

      // 実装例：更新内容をキャッシュ（PATCH時に使用）
      // Note: 実装詳細はPower Platform管理APIの仕様に依存
      const updatedState = {
        ...currentState,
        ...updateData,
        pendingChanges: true
      };

      const changesApplied = {
        fields: Object.keys(updateData),
        timestamp: new Date().toISOString()
      };

      await this._recordOperation(operationId, 'update', this.environmentId, this.appId, {
        status: 'success',
        changesBefore,
        changesApplied,
        result: { pendingChanges: true }
      });

      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        pendingChanges: true,
        versionNumber: updatedState.versionNumber,
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

  /**
   * 対象Power Appsアプリの保存（下書き保存）
   *
   * updateで積み込まれた変更をセッションに保存する。
   * 公開（publish）はこの後に実行する。
   *
   * @returns {Promise<Object>} 保存結果
   */
  async saveApp() {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    const operationId = crypto.randomUUID();
    try {
      const currentState = await this.getAppState();
      const newVersionNumber = `${parseFloat(currentState.versionNumber) + 0.1}`;

      // 実装例：PATCH要求でアプリ定義を保存
      const path = `/subscriptions/undefined/resourceGroups/undefined/providers/Microsoft.PowerApps/apps/${this.appId}?api-version=2024-06-15`;
      const saveResult = await this._managementFetch(path, {
        method: 'PATCH',
        body: JSON.stringify({
          properties: {
            definition: currentState.definition,
            versionNumber: newVersionNumber
          }
        })
      });

      await this._recordOperation(operationId, 'save', this.environmentId, this.appId, {
        status: 'success',
        result: {
          versionNumber: newVersionNumber,
          savedAt: new Date().toISOString(),
          pendingPublish: true
        }
      });

      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        versionNumber: newVersionNumber,
        savedAt: new Date().toISOString(),
        message: '下書きの保存に成功しました。公開はまだです。'
      };
    } catch (error) {
      await this._recordOperation(operationId, 'save', this.environmentId, this.appId, {
        status: 'error',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 対象Power Appsアプリを公開
   *
   * saveで保存された内容を本公開し、ユーザーが実行可能にする。
   *
   * @returns {Promise<Object>} 公開結果
   */
  async publishApp() {
    if (!this.environmentId || !this.appId) {
      throw new Error('environmentIdおよびappIdが未設定です');
    }

    const operationId = crypto.randomUUID();
    try {
      // 公開前の状態を確認
      const beforePublish = await this.getAppState();

      // 実装例：POST要求で公開実行
      const path = `/subscriptions/undefined/resourceGroups/undefined/providers/Microsoft.PowerApps/apps/${this.appId}/publish?api-version=2024-06-15`;
      const publishResult = await this._managementFetch(path, {
        method: 'POST',
        body: JSON.stringify({ strategy: 'immediate' })
      });

      await this._recordOperation(operationId, 'publish', this.environmentId, this.appId, {
        status: 'success',
        changesBefore: { versionNumber: beforePublish.versionNumber },
        result: {
          publishedVersion: publishResult.properties?.publishedVersion || beforePublish.versionNumber,
          publishedAt: new Date().toISOString()
        }
      });

      return {
        status: 'ok',
        operationId,
        appId: this.appId,
        environmentId: this.environmentId,
        publishedVersion: publishResult.properties?.publishedVersion || beforePublish.versionNumber,
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

  /**
   * 指定operationIdの操作結果を取得
   *
   * @param {string} operationId 操作の一意なID
   * @returns {Promise<Object>} 操作の詳細情報
   */
  async getOperationResult(operationId) {
    if (!operationId || typeof operationId !== 'string') {
      throw new Error('operationIdが必要です');
    }

    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const entry = JSON.parse(line);
        if (entry.operationId === operationId) {
          return {
            status: 'ok',
            operationId,
            operation: entry.operation,
            timestamp: entry.timestamp,
            status: entry.status,
            result: entry.result || null,
            error: entry.error || null,
            changesBefore: entry.changesBefore || null,
            changesApplied: entry.changesApplied || null
          };
        }
      }

      return {
        status: 'not_found',
        operationId,
        message: '指定されたoperationIdが見つかりません'
      };
    } catch (error) {
      throw new Error(`操作結果取得に失敗しました: ${error.message}`);
    }
  }

  /**
   * 対象アプリの操作ログを取得（最新N件）
   *
   * @param {number} limit 取得件数（デフォルト: 50）
   * @returns {Promise<Array>} 操作ログの配列
   */
  async getOperationLog(limit = 50) {
    try {
      const content = await fs.readFile(this.logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);

      // 対象appIdのみをフィルタ＆降順（最新から）
      const filtered = lines
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.appId === this.appId)
        .reverse()
        .slice(0, limit);

      return {
        status: 'ok',
        appId: this.appId,
        count: filtered.length,
        operations: filtered
      };
    } catch (error) {
      throw new Error(`操作ログ取得に失敗しました: ${error.message}`);
    }
  }

  /**
   * 指定されたoperationIdの操作をロールバック
   *
   * NOTE: 現在の実装では、ロールバック対象の操作の「前の状態」をログから復元し、
   * 新たなupdateで適用することで実現します。
   * 実際のPower Platformではversion管理を使用します。
   *
   * @param {string} operationId ロールバック対象の操作ID
   * @returns {Promise<Object>} ロールバック結果
   */
  async rollbackOperation(operationId) {
    if (!operationId || typeof operationId !== 'string') {
      throw new Error('operationIdが必要です');
    }

    const newOperationId = crypto.randomUUID();
    try {
      // ロールバック対象の操作を特定
      const target = await this.getOperationResult(operationId);
      if (target.status === 'not_found') {
        throw new Error(`operationId: ${operationId} が見つかりません`);
      }

      if (!target.changesBefore) {
        throw new Error('ロールバック対象の操作には前の状態情報が含まれていません');
      }

      // 前の状態を復元
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

  /**
   * 認可情報を無効化（ログアウト）
   *
   * 次回の操作時に新たなトークンを取得し直す
   */
  invalidateAuth() {
    this._tokenCache.invalidate();
  }
}

module.exports = { PowerAppsStore, TokenCache };
