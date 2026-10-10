/**
 * 支払監視通知エンジン
 *
 * 統合エンジン：
 * - PaymentMonitorService: 支払データ分析
 * - PaymentNotificationValidator: 誤検出防止
 * - PaymentNotificationIdempotency: 重複防止
 * - PaymentNotificationAuditLog: 監査証跡
 *
 * これらを組み合わせて、安全・確実な通知を実現
 */

const { PaymentMonitorService } = require('./paymentMonitorService');
const { PaymentNotificationValidator } = require('./paymentNotificationValidator');
const { PaymentNotificationIdempotency } = require('./paymentNotificationIdempotency');
const { PaymentNotificationAuditLog } = require('./paymentNotificationAuditLog');

class PaymentNotificationEngine {
  constructor(options = {}) {
    this.monitor = options.monitor || new PaymentMonitorService();
    this.validator = options.validator || new PaymentNotificationValidator(options.validatorConfig);
    this.idempotency = options.idempotency || new PaymentNotificationIdempotency(options.idempotencyConfig);
    this.auditLog = options.auditLog || new PaymentNotificationAuditLog(options.auditLogConfig);
  }

  /**
   * 支払データを分析し、通知対象を決定
   *
   * フロー:
   * 1. PaymentMonitorService で支払データを分析
   * 2. PaymentNotificationValidator で各案件の妥当性を検証
   * 3. PaymentNotificationIdempotency で24時間以内の重複通知をスキップ
   * 4. 通知対象をリストアップ
   * 5. PaymentNotificationAuditLog に記録
   */
  async prepareNotifications(paymentItems, columnSchema, options = {}) {
    const today = options.today || new Date();
    const result = {
      toNotify: [],
      skipped: [],
      invalid: [],
      analysis: null,
      errors: []
    };

    try {
      // Step 1: 支払データを分析
      this.auditLog.logValidation('analyze_payments', true);
      const analysis = this.monitor.analyzePayments(paymentItems, columnSchema, today);
      result.analysis = analysis;

      // Step 2-3: 期限超過案件を検証・フィルター
      for (const overdue of analysis.overdue) {
        // 妥当性検証
        const validation = this.validator.validateOverdueNotification(overdue, { today });
        if (!validation.valid) {
          result.invalid.push({
            ...overdue,
            validationErrors: validation.issues
          });
          this.auditLog.logValidation('validate_overdue', false, {
            estimateId: overdue.estimateId,
            issues: validation.issues.map(i => i.type)
          });
          continue;
        }

        // 重複通知チェック
        if (this.idempotency.shouldSkipNotification(overdue)) {
          result.skipped.push({
            ...overdue,
            reason: 'within_24_hours_no_status_change'
          });
          this.auditLog.logNotificationSkipped(overdue.estimateId, 'within_24_hours');
          continue;
        }

        // 通知対象として追加
        result.toNotify.push(overdue);
      }

      // Step 4: 通知結果を監査ログに記録
      this.auditLog.logAnalysis(
        analysis.overdue.length,
        analysis.pending.length,
        analysis.paid.length,
        analysis.cancelled.length
      );

      return result;
    } catch (error) {
      result.errors.push({
        operation: 'prepareNotifications',
        message: error.message,
        code: error.code
      });
      this.auditLog.logError('prepareNotifications', error);
      throw error;
    }
  }

  /**
   * 通知を送信し、履歴を記録
   */
  async sendNotifications(toNotify, notificationHandler, options = {}) {
    const results = {
      sent: [],
      failed: []
    };

    for (const overdue of toNotify) {
      try {
        // 通知を送信
        await notificationHandler(overdue);

        // 成功時に記録
        this.idempotency.recordNotification(overdue, 'sent');
        this.auditLog.logNotification('overdue_alert', overdue, 'sent');

        results.sent.push(overdue);
      } catch (error) {
        this.auditLog.logError('send_notification', error, {
          estimateId: overdue.estimateId,
          daysOverdue: overdue.daysOverdue
        });
        this.auditLog.logNotification('overdue_alert', overdue, 'failed');

        results.failed.push({
          ...overdue,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * 誤検出テスト: 実際の通知内容を検証
   */
  validateNotificationContent(overdue) {
    return this.validator.validateOverdueNotification(overdue);
  }

  /**
   * 許可リスト（allowlist）設定
   */
  setAllowlist(domains) {
    this.validator.allowlistDomains = [...domains];
  }

  /**
   * ブロックリスト（blocklist）設定
   */
  setBlocklist(estimateIds) {
    this.validator.blocklist = [...estimateIds];
  }

  /**
   * 監査ログをエクスポート
   */
  exportAuditLog(options = {}) {
    return this.auditLog.exportToCSV(options);
  }

  /**
   * 監査ログを読み込み
   */
  readAuditLog(options = {}) {
    return this.auditLog.readLog(options);
  }

  /**
   * メモリバッファをフラッシュ
   */
  flushLogs() {
    this.auditLog.flush();
  }
}

module.exports = { PaymentNotificationEngine };
