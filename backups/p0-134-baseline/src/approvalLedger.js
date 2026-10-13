/**
 * Approval Ledger（承認台帳）
 *
 * 実行依頼の承認を、SharePoint の承認台帳で確認する。
 * - 承認は人間が承認台帳に記録する。AI は承認を作成・更新しない（読み取りのみ）。
 * - フラグ（approvedByHuman など）による承認は受け付けない。
 * - 列の内部名は、実環境で確認された値だけを設定として渡す。未設定なら承認なしとして止める（fail closed）。
 */

const APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APPROVED_STATUS = '承認';

/** 承認台帳の列名（内部名）の既定値は持たない。設定で明示された場合だけ使う。 */
const REQUIRED_FIELD_KEYS = Object.freeze(['requestId', 'stepIndex', 'tool', 'status', 'approver', 'approvedAt', 'revoked']);

/**
 * 承認レコードを、依頼と照合して検証する。
 * @returns {{valid: boolean, reason: string|null}}
 */
function validateApprovalRecord(record, expected, { now = new Date() } = {}) {
  if (!record || typeof record !== 'object') return { valid: false, reason: 'no_record' };
  if (record.requestId !== expected.requestId) return { valid: false, reason: 'request_mismatch' };
  if (Number(record.stepIndex) !== expected.stepIndex) return { valid: false, reason: 'step_mismatch' };
  if (record.tool !== expected.tool) return { valid: false, reason: 'tool_mismatch' };
  if (record.status !== APPROVED_STATUS) return { valid: false, reason: 'not_approved' };
  if (record.revoked === true || record.revoked === 'はい') return { valid: false, reason: 'revoked' };
  if (typeof record.approver !== 'string' || record.approver.trim() === '') return { valid: false, reason: 'approver_missing' };
  const approvedAt = Date.parse(record.approvedAt);
  if (Number.isNaN(approvedAt)) return { valid: false, reason: 'approved_at_invalid' };
  if (approvedAt > now.getTime() + 60 * 1000) return { valid: false, reason: 'approved_at_in_future' };
  if (now.getTime() - approvedAt > APPROVAL_MAX_AGE_MS) return { valid: false, reason: 'approval_expired' };
  return { valid: true, reason: null };
}

/**
 * 承認台帳の設定を検証する。必要な列名がすべて指定されていなければ未設定とみなす。
 * @param {object} config - { fieldMap: { requestId, stepIndex, tool, status, approver, approvedAt, revoked }, listId, siteId }
 */
function isApprovalLedgerConfigured(config) {
  if (!config || !config.siteId || !config.listId || !config.fieldMap) return false;
  return REQUIRED_FIELD_KEYS.every((key) => typeof config.fieldMap[key] === 'string' && config.fieldMap[key].length > 0);
}

/**
 * 承認台帳リーダー。fetchRows は SharePoint からの行取得を注入する（テスト容易性のため）。
 * 未設定、または取得できない場合は、承認なしとして扱う。
 */
class ApprovalLedger {
  constructor({ config = null, fetchRows = null, now = () => new Date() } = {}) {
    this.config = config;
    this.fetchRows = fetchRows;
    this.now = now;
    this.configured = isApprovalLedgerConfigured(config) && typeof fetchRows === 'function';
  }

  /** 依頼・ステップに対する有効な承認があるか。結果は理由付きで返す。 */
  async check(expected) {
    if (!this.configured) return { approved: false, reason: 'ledger_not_configured' };
    let rows;
    try {
      rows = await this.fetchRows({ requestId: expected.requestId, stepIndex: expected.stepIndex });
    } catch {
      return { approved: false, reason: 'ledger_unreadable' };
    }
    if (!Array.isArray(rows) || rows.length === 0) return { approved: false, reason: 'no_record' };
    const map = this.config.fieldMap;
    const normalized = rows.map((row) => ({
      requestId: row[map.requestId],
      stepIndex: row[map.stepIndex],
      tool: row[map.tool],
      status: row[map.status],
      approver: row[map.approver],
      approvedAt: row[map.approvedAt],
      revoked: row[map.revoked]
    }));
    let last = { valid: false, reason: 'no_record' };
    for (const record of normalized) {
      const result = validateApprovalRecord(record, expected, { now: this.now() });
      if (result.valid) return { approved: true, reason: null, approver: record.approver };
      last = result;
    }
    return { approved: false, reason: last.reason };
  }
}

module.exports = {
  ApprovalLedger,
  APPROVAL_MAX_AGE_MS,
  APPROVED_STATUS,
  isApprovalLedgerConfigured,
  validateApprovalRecord
};
