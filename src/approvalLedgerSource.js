/**
 * 承認台帳の取得元（SharePoint）
 *
 * ApprovalLedger に渡す fetchRows を作る。読み取り専用で、作成・更新・削除は行わない。
 * - 取得は SharePointReader.fetchListFields に任せる（認証は既存の SHAREPOINT_* を再利用）。
 * - 依頼ID・ステップ番号で絞り込み、内部名キーの生データを返す。判定は ApprovalLedger 側で行う。
 * - 列名・リスト名は設定（APPROVAL_LEDGER_*）から受け取り、既定値を持たない。
 */

/**
 * @param {object} options
 * @param {object} options.reader - SharePointReader 互換（fetchListFields を持つ）
 * @param {object} options.config - config.approvalLedger（{ siteId, listId, listName, fieldMap }）
 * @returns {(expected: {requestId: string, stepIndex: number}) => Promise<object[]>}
 */
function createApprovalLedgerFetchRows({ reader, config }) {
  return async ({ requestId, stepIndex }) => {
    const map = config.fieldMap;
    const items = await reader.fetchListFields({
      siteId: config.siteId,
      listId: config.listId || undefined,
      listName: config.listId ? undefined : config.listName
    });
    return items.filter((fields) => fields[map.requestId] === requestId && Number(fields[map.stepIndex]) === stepIndex);
  };
}

module.exports = { createApprovalLedgerFetchRows };
