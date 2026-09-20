/**
 * SharePoint読み取り／Power Automate実行まわりのリクエスト入力検証。
 * Power Apps関連はpowerAppsValidation.jsに分離されているのに合わせ、こちらも独立させる。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateGetSharePointListParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  if (params.listId !== undefined && typeof params.listId !== 'string') return 'listIdは文字列である必要があります';
  if (params.listName !== undefined && typeof params.listName !== 'string') return 'listNameは文字列である必要があります';
  if (!params.listId && !params.listName) return 'listIdまたはlistNameのいずれかが必要です';
  if (params.siteId !== undefined && typeof params.siteId !== 'string') return 'siteIdは文字列である必要があります';
  if (params.top !== undefined && (typeof params.top !== 'number' || !Number.isFinite(params.top) || params.top < 1)) {
    return 'topは1以上の数値である必要があります';
  }
  return null;
}

function validateRunPowerAutomateFlowParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  if (typeof params.flowKey !== 'string' || !params.flowKey.trim()) return 'flowKeyが必要です';
  if (params.payload !== undefined && !isPlainObject(params.payload)) return 'payloadはJSONオブジェクトである必要があります';
  if (params.approvedByHuman !== true) return 'approvedByHuman:trueが必要です（人間承認が必要な操作です）';
  return null;
}

// CN_社員台帳への書き込み（create/update）は、他の更新・実行系（run_power_automate_flow等）と
// 同じくBridge全体の方針（AI単独承認禁止）に合わせ、approvedByHuman:trueを必須にする。
function validateCreateEmployeeLedgerEntryParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  if (!isPlainObject(params.record)) return 'recordが必要です（JSONオブジェクト）';
  if (params.approvedByHuman !== true) return 'approvedByHuman:trueが必要です（人間承認が必要な操作です）';
  return null;
}

function validateUpdateEmployeeLedgerEntryParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  if (typeof params.itemId !== 'string' || !params.itemId.trim()) return 'itemIdが必要です';
  if (!isPlainObject(params.record)) return 'recordが必要です（JSONオブジェクト）';
  if (params.approvedByHuman !== true) return 'approvedByHuman:trueが必要です（人間承認が必要な操作です）';
  return null;
}

module.exports = {
  validateGetSharePointListParams,
  validateRunPowerAutomateFlowParams,
  validateCreateEmployeeLedgerEntryParams,
  validateUpdateEmployeeLedgerEntryParams
};
