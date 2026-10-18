/**
 * 支払監視通知のIDEMPOTENCY（重複防止）エンジン
 *
 * 目的:
 * - 同一期限超過案件への重複通知を防止
 * - 通知送信履歴を記録
 * - スキップ条件を判定（既通知、クリア、キャンセル）
 */

const crypto = require('crypto');

class PaymentNotificationIdempotency {
  constructor(options = {}) {
    this.store = options.store || new Map(); // Key: hashKey, Value: { timestamp, status, overdueState }
    this.maxHistoryDays = options.maxHistoryDays || 30; // 30日以上前の履歴は削除
  }

  /**
   * 通知対象の案件からハッシュキーを生成
   * ハッシュ = estimateId + dueDate
   * 同じ見積・同じ期限なら同じハッシュ = 重複判定可
   */
  generateNotificationHash(overdue) {
    const key = `${overdue.estimateId || 'unknown'}:${overdue.dueDate || 'unknown'}`;
    return crypto.createHash('sha256').update(key).digest('hex').substring(0, 16);
  }

  /**
   * 通知を記録（送信成功時に呼び出す）
   */
  recordNotification(overdue, status = 'sent') {
    const hash = this.generateNotificationHash(overdue);
    this.store.set(hash, {
      timestamp: new Date().toISOString(),
      status: status, // 'sent' | 'skipped' | 'failed'
      estimateId: overdue.estimateId,
      dueDate: overdue.dueDate,
      daysOverdue: overdue.daysOverdue,
      amount: overdue.amount
    });
  }

  /**
   * 通知スキップ判定
   *
   * スキップ条件:
   * 1. 24時間以内に同じ期限超過案件へ通知済み
   * 2. 通知記録の超過日数 >= 現在の超過日数（状態が悪化していない）
   *
   * スキップ不要（通知続行）条件:
   * 1. 初回通知
   * 2. 24時間以上経過
   * 3. 超過日数が増加している（状態が悪化している）
   */
  shouldSkipNotification(overdue) {
    const hash = this.generateNotificationHash(overdue);
    const record = this.store.get(hash);

    // 通知記録なし = 初回
    if (!record) return false;

    const lastNotificationTime = new Date(record.timestamp);
    const now = new Date();
    const hoursSinceNotification = (now - lastNotificationTime) / (1000 * 60 * 60);

    // 24時間以内かつ、超過日数が同じか少ない = スキップ
    if (hoursSinceNotification < 24 && record.daysOverdue >= overdue.daysOverdue) {
      return true;
    }

    return false;
  }

  /**
   * 通知記録から履歴をクリア
   * maxHistoryDays以上前の記録を削除
   */
  pruneOldRecords(today = new Date()) {
    const cutoffDate = new Date(today);
    cutoffDate.setDate(cutoffDate.getDate() - this.maxHistoryDays);

    for (const [hash, record] of this.store.entries()) {
      const recordDate = new Date(record.timestamp);
      if (recordDate < cutoffDate) {
        this.store.delete(hash);
      }
    }
  }

  /**
   * 通知記録を返す（デバッグ・監査用）
   */
  getRecords() {
    return Array.from(this.store.entries()).map(([hash, record]) => ({
      hash,
      ...record
    }));
  }

  /**
   * 指定ハッシュの記録を削除（テスト用）
   */
  clearRecord(hash) {
    this.store.delete(hash);
  }

  /**
   * すべての記録を削除（テスト用）
   */
  clearAll() {
    this.store.clear();
  }
}

module.exports = { PaymentNotificationIdempotency };
