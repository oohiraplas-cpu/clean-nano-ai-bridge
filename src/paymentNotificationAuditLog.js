/**
 * 支払監視通知の監査証跡ログ
 *
 * 目的:
 * - すべての通知操作を記録
 * - いつ、誰が、何を、なぜ実行したかを追跡可能にする
 * - コンプライアンス・トレーサビリティ確保
 */

const fs = require('fs');
const path = require('path');

class PaymentNotificationAuditLog {
  constructor(options = {}) {
    this.logFilePath = options.logFilePath || path.join(process.cwd(), 'data', 'payment-notification-audit.log');
    this.maxEntriesInMemory = options.maxEntriesInMemory || 1000;
    this.memoryBuffer = []; // メモリバッファ（定期的にファイルに書き込む）
    this._ensureLogDirectory();
  }

  /**
   * ログディレクトリを確保
   */
  _ensureLogDirectory() {
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 監査ログエントリを作成
   */
  _createEntry(action, details) {
    return {
      timestamp: new Date().toISOString(),
      action,
      details,
      version: '1.0'
    };
  }

  /**
   * メモリバッファにログを追加し、容量超過時はファイルに書き込む
   */
  _addToBuffer(entry) {
    this.memoryBuffer.push(entry);
    if (this.memoryBuffer.length >= this.maxEntriesInMemory) {
      this.flush();
    }
  }

  /**
   * メモリバッファをファイルに書き込み
   */
  flush() {
    if (this.memoryBuffer.length === 0) return;

    try {
      const lines = this.memoryBuffer.map(entry => JSON.stringify(entry));
      fs.appendFileSync(this.logFilePath, lines.join('\n') + '\n', 'utf8');
      this.memoryBuffer = [];
    } catch (error) {
      console.error('Failed to flush audit log:', error.message);
    }
  }

  /**
   * 発見操作をログ
   */
  logDiscovery(siteCount, paymentListId, paymentSiteId) {
    const entry = this._createEntry('DISCOVERY', {
      operation: 'discover_sharepoint_ai4_resources',
      sitesDiscovered: siteCount,
      paymentListId,
      paymentSiteId,
      readOnlyMode: true
    });
    this._addToBuffer(entry);
  }

  /**
   * データ取得をログ
   */
  logDataFetch(itemCount, listId, siteId) {
    const entry = this._createEntry('DATA_FETCH', {
      operation: 'read_payment_list',
      itemsRetrieved: itemCount,
      listId,
      siteId,
      readOnlyMode: true,
      noDataModified: true
    });
    this._addToBuffer(entry);
  }

  /**
   * 分析をログ
   */
  logAnalysis(overdueCounts, pendingCounts, paidCounts, cancelledCounts) {
    const entry = this._createEntry('ANALYSIS', {
      operation: 'analyze_payments',
      results: {
        overdueCount: overdueCounts,
        pendingCount: pendingCounts,
        paidCount: paidCounts,
        cancelledCount: cancelledCounts
      }
    });
    this._addToBuffer(entry);
  }

  /**
   * 検証テストをログ
   */
  logValidation(testName, passed, details = {}) {
    const entry = this._createEntry('VALIDATION', {
      operation: 'run_validation_test',
      testName,
      status: passed ? 'PASS' : 'FAIL',
      details
    });
    this._addToBuffer(entry);
  }

  /**
   * 通知をログ
   */
  logNotification(notificationType, overdue, status = 'sent') {
    const entry = this._createEntry('NOTIFICATION', {
      operation: 'send_notification',
      type: notificationType,
      estimateId: overdue.estimateId,
      dueDate: overdue.dueDate,
      daysOverdue: overdue.daysOverdue,
      amount: overdue.amount,
      status
    });
    this._addToBuffer(entry);
  }

  /**
   * 通知スキップをログ
   */
  logNotificationSkipped(estimateId, reason) {
    const entry = this._createEntry('NOTIFICATION_SKIPPED', {
      operation: 'skip_notification',
      estimateId,
      reason
    });
    this._addToBuffer(entry);
  }

  /**
   * エラーをログ
   */
  logError(operation, error, context = {}) {
    const entry = this._createEntry('ERROR', {
      operation,
      errorMessage: error.message,
      errorCode: error.code,
      context
    });
    this._addToBuffer(entry);
  }

  /**
   * Power Automate統合のセットアップをログ
   */
  logPowerAutomateSetup(details) {
    const entry = this._createEntry('POWER_AUTOMATE_SETUP', {
      operation: 'setup_power_automate_workflow',
      ...details,
      readOnlyMode: true, // 初回セットアップは下書きまで
      notificationEnabled: false // 本番通知は未有効化
    });
    this._addToBuffer(entry);
  }

  /**
   * 監査ログを読み込み
   */
  readLog(options = {}) {
    const limit = options.limit || 100;
    const reverse = options.reverse !== false; // デフォルトは新しい順

    try {
      if (!fs.existsSync(this.logFilePath)) {
        return [];
      }

      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line);
      const entries = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      }).filter(entry => entry !== null);

      if (reverse) {
        entries.reverse();
      }

      return entries.slice(0, limit);
    } catch (error) {
      console.error('Failed to read audit log:', error.message);
      return [];
    }
  }

  /**
   * 監査ログをフィルター
   */
  filterLog(filterFn, options = {}) {
    const allEntries = this.readLog({ limit: options.limit || Infinity });
    return allEntries.filter(filterFn);
  }

  /**
   * 監査ログをアクション別に集計
   */
  summarizeByAction(options = {}) {
    const entries = this.readLog({ limit: options.limit || Infinity });
    const summary = {};

    for (const entry of entries) {
      summary[entry.action] = (summary[entry.action] || 0) + 1;
    }

    return summary;
  }

  /**
   * 監査ログをCSV形式でエクスポート
   */
  exportToCSV(options = {}) {
    const entries = this.readLog({ limit: options.limit || Infinity });
    if (entries.length === 0) return '';

    const headers = ['timestamp', 'action', 'status', 'details'];
    const rows = entries.map(entry => [
      entry.timestamp,
      entry.action,
      entry.details?.status || '-',
      JSON.stringify(entry.details)
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${(cell || '').toString().replace(/"/g, '""')}"`).join(','))
      .join('\n');

    return csv;
  }
}

module.exports = { PaymentNotificationAuditLog };
