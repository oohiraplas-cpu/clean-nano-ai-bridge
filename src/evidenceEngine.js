/**
 * Phase 9 Evidence Capture Engine
 * 実行時の全ての重要状態・結果・証拠を自動収集
 */

class EvidenceEngine {
  constructor() {
    this.evidenceStore = {
      timestamp: new Date().toISOString(),
      items: []
    };
  }

  /**
   * Bridge MCP呼び出し時の証跡取得
   */
  captureMethodCall(method, params, response, httpStatus) {
    this.evidenceStore.items.push({
      type: 'method_call',
      method,
      timestamp: new Date().toISOString(),
      request: this._sanitize(params),
      response: this._sanitize(response),
      httpStatus,
      correlationId: params.correlationId || response?.correlationId
    });
  }

  /**
   * State取得時の証跡
   */
  captureState(appId, stateData) {
    this.evidenceStore.items.push({
      type: 'state_snapshot',
      appId,
      timestamp: new Date().toISOString(),
      state: this._sanitize(stateData),
      sha: stateData?.sha,
      branch: stateData?.branch,
      environment: stateData?.environment
    });
  }

  /**
   * Save操作の証跡
   */
  captureSave(appId, correlationId, result) {
    this.evidenceStore.items.push({
      type: 'save_operation',
      appId,
      correlationId,
      timestamp: new Date().toISOString(),
      status: result.status,
      message: result.message,
      newSha: result.sha
    });
  }

  /**
   * Publish操作の証跡
   */
  capturePublish(appId, correlationId, result) {
    this.evidenceStore.items.push({
      type: 'publish_operation',
      appId,
      correlationId,
      timestamp: new Date().toISOString(),
      status: result.status,
      message: result.message,
      publishedVersion: result.version
    });
  }

  /**
   * 画面表示確認の証跡（スクリーンショット等）
   */
  captureScreenshot(appId, screenshotUrl, timestamp) {
    this.evidenceStore.items.push({
      type: 'screenshot',
      appId,
      timestamp: timestamp || new Date().toISOString(),
      screenshot_url: screenshotUrl,
      verified: true
    });
  }

  /**
   * Runtime再取得確認の証跡
   */
  captureRuntimeVerification(appId, beforeState, afterState, match) {
    this.evidenceStore.items.push({
      type: 'runtime_verification',
      appId,
      timestamp: new Date().toISOString(),
      before: this._sanitize(beforeState),
      after: this._sanitize(afterState),
      state_match: match
    });
  }

  /**
   * 権限確認の証跡
   */
  capturePermissionCheck(appId, permissions) {
    this.evidenceStore.items.push({
      type: 'permission_check',
      appId,
      timestamp: new Date().toISOString(),
      permissions: permissions
    });
  }

  /**
   * エラーの証跡
   */
  captureError(severity, message, context) {
    this.evidenceStore.items.push({
      type: 'error',
      severity, // 'critical' | 'warning' | 'info'
      timestamp: new Date().toISOString(),
      message,
      context: this._sanitize(context)
    });
  }

  /**
   * 監査ログエントリ
   */
  auditLog(action, actor, target, result) {
    if (!this.evidenceStore.audit_log) {
      this.evidenceStore.audit_log = [];
    }
    this.evidenceStore.audit_log.push({
      timestamp: new Date().toISOString(),
      action,
      actor,
      target,
      result
    });
  }

  /**
   * 秘密値をマスク
   */
  _sanitize(data) {
    if (!data) return data;
    if (typeof data !== 'object') return data;

    const sanitized = JSON.parse(JSON.stringify(data));
    const secrets = ['apiKey', 'token', 'password', 'secret', 'auth'];

    const maskRecursive = (obj) => {
      for (const key in obj) {
        if (secrets.some(s => key.toLowerCase().includes(s))) {
          obj[key] = '***MASKED***';
        } else if (typeof obj[key] === 'object') {
          maskRecursive(obj[key]);
        }
      }
    };

    maskRecursive(sanitized);
    return sanitized;
  }

  /**
   * 証跡一覧を取得
   */
  getEvidence() {
    return this.evidenceStore;
  }

  /**
   * 証跡をフォーマット出力
   */
  formatEvidence() {
    const summary = {
      timestamp: this.evidenceStore.timestamp,
      total_items: this.evidenceStore.items.length,
      items_by_type: {},
      audit_entries: this.evidenceStore.audit_log?.length || 0
    };

    // アイテムを種別ごとに集計
    this.evidenceStore.items.forEach(item => {
      if (!summary.items_by_type[item.type]) {
        summary.items_by_type[item.type] = 0;
      }
      summary.items_by_type[item.type]++;
    });

    return summary;
  }

  /**
   * 必須証跡の確認
   */
  validateRequiredEvidence() {
    const required = {
      'method_call': 5, // 最低5回のメソッド呼び出し記録
      'state_snapshot': 2, // 最低2回のState取得
      'save_operation': 1, // Save操作の記録
      'publish_operation': 1, // Publish操作の記録
      'runtime_verification': 1, // Runtime再確認の記録
      'audit_log': 1 // 監査ログ
    };

    const missing = [];
    const summary = this.formatEvidence();

    for (const [type, minCount] of Object.entries(required)) {
      const actual = type === 'audit_log' ? summary.audit_entries : (summary.items_by_type[type] || 0);
      if (actual < minCount) {
        missing.push(`${type}: ${actual}/${minCount} (不足 ${minCount - actual}件)`);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      summary
    };
  }
}

module.exports = EvidenceEngine;
