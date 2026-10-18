/**
 * 支払監視通知の誤検出防止エンジン
 *
 * 目的:
 * - 期限超過判定の精度検証
 * - 誤りやすいエッジケースを検出
 * - 通知対象から除外すべき案件を識別
 */

class PaymentNotificationValidator {
  constructor(options = {}) {
    this.allowlistDomains = options.allowlistDomains || []; // 許可サイト一覧
    this.blocklist = options.blocklist || []; // ブロックリスト
  }

  /**
   * 個別案件の通知妥当性を検証
   *
   * 検証項目:
   * 1. 期限日が妥当か（未来日に設定されていないか）
   * 2. 見積IDが有効か（空でないか、形式が正しいか）
   * 3. ブロックリスト未登録か
   * 4. 期限超過が確実か（入金日なしを確認）
   * 5. キャンセルや特別ステータスでないか
   */
  validateOverdueNotification(overdue, options = {}) {
    const issues = [];
    const today = options.today || new Date();

    // 1. 期限日の妥当性
    if (!overdue.dueDate) {
      issues.push({
        type: 'missing_due_date',
        severity: 'critical',
        message: '期限日が未設定。通知対象外。'
      });
      return { valid: false, issues };
    }

    const dueDate = new Date(overdue.dueDate);
    if (isNaN(dueDate.getTime())) {
      issues.push({
        type: 'invalid_date_format',
        severity: 'critical',
        message: `期限日形式が無効: ${overdue.dueDate}`
      });
      return { valid: false, issues };
    }

    if (dueDate > today) {
      issues.push({
        type: 'future_due_date',
        severity: 'high',
        message: `期限が未来: ${overdue.dueDate.split('T')[0]} > ${today.toISOString().split('T')[0]}`
      });
      return { valid: false, issues };
    }

    // 2. 見積IDの妥当性
    if (!overdue.estimateId || overdue.estimateId.trim() === '') {
      issues.push({
        type: 'missing_estimate_id',
        severity: 'high',
        message: '見積IDが未設定。通知対象外。'
      });
      return { valid: false, issues };
    }

    // 3. ブロックリスト確認
    if (this._isBlocklisted(overdue.estimateId)) {
      issues.push({
        type: 'blocklisted',
        severity: 'medium',
        message: `見積IDはブロックリスト登録済み: ${overdue.estimateId}`
      });
      return { valid: false, issues };
    }

    // 4. 入金日確認（期限超過であることを確認）
    if (overdue.paidDate) {
      issues.push({
        type: 'already_paid',
        severity: 'critical',
        message: `既に入金済み: ${overdue.paidDate}`
      });
      return { valid: false, issues };
    }

    // 5. キャンセルステータス確認
    if (overdue.status && this._isCancelledStatus(overdue.status)) {
      issues.push({
        type: 'cancelled_item',
        severity: 'high',
        message: `キャンセル済み案件: ${overdue.status}`
      });
      return { valid: false, issues };
    }

    // 6. 超過日数が妥当か
    if (overdue.daysOverdue < 0) {
      issues.push({
        type: 'negative_overdue_days',
        severity: 'critical',
        message: `超過日数が負: ${overdue.daysOverdue}日`
      });
      return { valid: false, issues };
    }

    // すべてのチェックを通過
    return { valid: true, issues };
  }

  /**
   * 許可サイト（allowlist）の確認
   */
  validateAllowlist(overdue) {
    if (this.allowlistDomains.length === 0) {
      // allowlistが空の場合は許可制限なし
      return { allowed: true };
    }

    // estimateId の prefix または domain 形式で確認
    for (const domain of this.allowlistDomains) {
      if (overdue.estimateId.startsWith(domain)) {
        return { allowed: true, matchedDomain: domain };
      }
    }

    return {
      allowed: false,
      message: `見積IDはallowlist未登録: ${overdue.estimateId}`,
      allowedDomains: this.allowlistDomains
    };
  }

  /**
   * 複数案件の通知妥当性を一括検証
   */
  validateOverdueList(overdueList, options = {}) {
    const valid = [];
    const invalid = [];

    for (const overdue of overdueList) {
      const result = this.validateOverdueNotification(overdue, options);
      if (result.valid) {
        valid.push(overdue);
      } else {
        invalid.push({
          ...overdue,
          validationErrors: result.issues
        });
      }
    }

    return {
      validCount: valid.length,
      invalidCount: invalid.length,
      valid,
      invalid,
      acceptanceRate: overdueList.length > 0
        ? (valid.length / overdueList.length * 100).toFixed(1) + '%'
        : 'N/A'
    };
  }

  /**
   * ブロックリスト登録（通知対象外の見積IDを追加）
   */
  addToBlocklist(estimateId) {
    if (!this.blocklist.includes(estimateId)) {
      this.blocklist.push(estimateId);
    }
  }

  /**
   * Allowlist登録（通知対象サイトを追加）
   */
  addToAllowlist(domain) {
    if (!this.allowlistDomains.includes(domain)) {
      this.allowlistDomains.push(domain);
    }
  }

  /**
   * Allowlist取得
   */
  getAllowlist() {
    return [...this.allowlistDomains];
  }

  /**
   * ブロックリスト取得
   */
  getBlocklist() {
    return [...this.blocklist];
  }

  /**
   * 内部: ブロックリスト確認
   */
  _isBlocklisted(estimateId) {
    return this.blocklist.includes(estimateId);
  }

  /**
   * 内部: キャンセルステータス判定
   */
  _isCancelledStatus(status) {
    const cancelKeywords = ['キャンセル', 'cancelled', 'cancel', 'cancelled_item', 'キャンセル済み'];
    const normalizedStatus = (status || '').toLowerCase();
    return cancelKeywords.some(kw => normalizedStatus.includes(kw.toLowerCase()));
  }
}

module.exports = { PaymentNotificationValidator };
