/**
 * 未入金監視サービス
 * SharePoint AI4 支払管理リストから未入金・遅延案件を検出
 *
 * 入金判定ロジック:
 * - 期限超過 = 請求期限 < 本日 AND 入金日未記入
 * - 遅延日数 = MAX(0, 本日 - 請求期限)
 * - ステータス = { 期限内, 期限超過, 入金済み, キャンセル }
 */

class PaymentMonitorService {
  constructor(config = {}) {
    this.sharePointReader = config.sharePointReader || null;
    this.defaultSiteId = config.siteId || '';
    this.paymentListId = config.paymentListId || '';
    this.paymentListName = config.paymentListName || '支払管理';
    this.invoiceListId = config.invoiceListId || '';
    this.invoiceListName = config.invoiceListName || '請求管理';
    this.projectListId = config.projectListId || '';
    this.projectListName = config.projectListName || '案件管理';
  }

  /**
   * 日付文字列をDateオブジェクトに変換（ISO 8601対応）
   */
  _parseDate(dateStr) {
    if (!dateStr) return null;
    if (typeof dateStr === 'object') return dateStr;
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * 遅延日数計算
   * @param {string|Date} dueDateStr 期限日
   * @param {string|Date} paidDateStr 入金日（未記入の場合null）
   * @param {Date} today 本日（デフォルト: 現在時刻）
   * @returns {object} { status, daysOverdue, daysUntilDue, statusLabel }
   */
  calculatePaymentStatus(dueDateStr, paidDateStr, today = new Date()) {
    const dueDate = this._parseDate(dueDateStr);
    const paidDate = this._parseDate(paidDateStr);

    if (!dueDate) {
      return { status: 'unknown', daysOverdue: 0, daysUntilDue: null, statusLabel: '期限未設定' };
    }

    // 既に入金済みの場合
    if (paidDate) {
      const daysToPayment = Math.floor((paidDate - dueDate) / (1000 * 60 * 60 * 24));
      return {
        status: 'paid',
        daysOverdue: Math.max(0, daysToPayment),
        daysUntilDue: 0,
        statusLabel: daysToPayment <= 0 ? '期限内入金' : '遅延入金',
        paidDate: paidDate.toISOString().split('T')[0]
      };
    }

    // 未入金の場合
    const daysUntilDue = Math.floor((dueDate - today) / (1000 * 60 * 60 * 24));
    if (daysUntilDue >= 0) {
      return {
        status: 'pending',
        daysOverdue: 0,
        daysUntilDue,
        statusLabel: `あと${daysUntilDue + 1}日で期限`
      };
    } else {
      return {
        status: 'overdue',
        daysOverdue: -daysUntilDue,
        daysUntilDue: 0,
        statusLabel: `期限超過 ${-daysUntilDue}日`
      };
    }
  }

  /**
   * 支払管理リストから全件取得（サンプル：最大200件）
   * @param {object} params { siteId?, top?: 50-200 }
   * @returns {object} { items, columns, ... }
   */
  async getPaymentList(params = {}) {
    if (!this.sharePointReader) {
      throw new Error('SharePointReader が構成されていません');
    }
    return this.sharePointReader.listItems({
      siteId: params.siteId || this.defaultSiteId,
      listId: params.listId || this.paymentListId,
      listName: params.listName || this.paymentListName,
      top: params.top || 100
    });
  }

  /**
   * 未入金・遅延案件の検出
   * @param {Array} paymentItems 支払管理リストのitems
   * @param {Array} columnSchema 列定義スキーマ
   * @param {Date} today 本日（デフォルト: 現在時刻）
   * @returns {object} { overdue, pending, paid, summary }
   */
  analyzePayments(paymentItems, columnSchema, today = new Date()) {
    if (!Array.isArray(paymentItems)) return { overdue: [], pending: [], paid: [], summary: null };

    // 列名マッピング（実装時に合わせて調整）
    // 想定列: estimateId, invoiceId, invoiceDate, dueDate, paidDate, amount, status
    const getField = (item, fieldNames) => {
      const fields = item.fields || {};
      for (const name of fieldNames) {
        if (fields[name] !== undefined && fields[name] !== null && fields[name] !== '') {
          return fields[name];
        }
      }
      return null;
    };

    const results = {
      overdue: [],
      pending: [],
      paid: [],
      cancelled: [],
      unknown: []
    };

    let totalAmount = 0;
    let overdueAmount = 0;

    paymentItems.forEach((item, index) => {
      const estimateId = getField(item, ['estimateId', 'estimate_id', '見積ID', 'EstimateId']);
      const invoiceId = getField(item, ['invoiceId', 'invoice_id', '請求ID', 'InvoiceId']);
      const dueDate = getField(item, ['dueDate', 'due_date', '期限日', 'DueDate']);
      const paidDate = getField(item, ['paidDate', 'paid_date', '入金日', 'PaidDate']);
      const amount = Number.parseFloat(getField(item, ['amount', 'invoiceAmount', '金額', 'Amount']) || 0);
      const status = getField(item, ['status', 'paymentStatus', 'ステータス', 'Status']);

      // キャンセル済みはスキップ（totalAmount に含めない）
      if (status === 'キャンセル' || status === 'cancelled' || status === 'cancel') {
        results.cancelled.push({ itemId: item.itemId, estimateId, invoiceId, amount, reason: 'キャンセル済み' });
        return;
      }

      const paymentStatus = this.calculatePaymentStatus(dueDate, paidDate, today);

      // totalAmount はキャンセルを除いた実績金額
      totalAmount += amount;

      const record = {
        itemId: item.itemId,
        estimateId,
        invoiceId,
        dueDate: dueDate ? new Date(dueDate).toISOString().split('T')[0] : null,
        paidDate: paidDate ? new Date(paidDate).toISOString().split('T')[0] : null,
        amount,
        ...paymentStatus
      };

      if (paymentStatus.status === 'overdue') {
        results.overdue.push(record);
        overdueAmount += amount;
      } else if (paymentStatus.status === 'pending') {
        results.pending.push(record);
      } else if (paymentStatus.status === 'paid') {
        results.paid.push(record);
      } else {
        results.unknown.push(record);
      }
    });

    // ソート：期限超過は超過日数が長い順、未入金は期限が近い順
    results.overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
    results.pending.sort((a, b) => a.daysUntilDue - b.daysUntilDue);

    results.summary = {
      total: paymentItems.length,
      overdueCount: results.overdue.length,
      pendingCount: results.pending.length,
      paidCount: results.paid.length,
      cancelledCount: results.cancelled.length,
      unknownCount: results.unknown.length,
      totalAmount,
      overdueAmount,
      overdueRate: totalAmount > 0 ? ((overdueAmount / totalAmount) * 100).toFixed(1) : 0
    };

    return results;
  }

  /**
   * 未入金監視レポート生成
   * @param {object} params { siteId?, top? }
   * @returns {object} { analysis, errors, timestamp }
   */
  async generatePaymentReport(params = {}) {
    const errors = [];
    let analysis = null;

    try {
      const listData = await this.getPaymentList(params);
      analysis = this.analyzePayments(listData.items, listData.columns);
    } catch (error) {
      errors.push(`支払管理リスト取得エラー: ${error.message}`);
    }

    return {
      analysis: analysis || { overdue: [], pending: [], paid: [], cancelled: [], unknown: [], summary: null },
      errors,
      timestamp: new Date().toISOString(),
      reportGeneratedAt: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    };
  }

  /**
   * 期限超過案件のみを高速抽出（毎日通知用）
   */
  async getOverduePayments(params = {}) {
    const report = await this.generatePaymentReport(params);
    if (report.errors.length > 0) {
      return { status: 'error', errors: report.errors, overdue: [] };
    }

    const { overdue, summary } = report.analysis;
    return {
      status: 'ok',
      overdue: overdue.map(p => ({
        estimateId: p.estimateId,
        invoiceId: p.invoiceId,
        daysOverdue: p.daysOverdue,
        amount: p.amount,
        dueDate: p.dueDate,
        statusLabel: p.statusLabel
      })),
      summary: {
        count: overdue.length,
        totalAmount: summary.overdueAmount,
        reportTime: report.reportGeneratedAt
      }
    };
  }
}

module.exports = { PaymentMonitorService };
