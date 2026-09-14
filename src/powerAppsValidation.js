/**
 * Power Apps関連のリクエスト入力検証
 */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Power Apps MCP入力検証
 * @param {Object} body リクエスト本文
 * @returns {string|null} エラーメッセージ、またはnull
 */
function validatePowerAppsMcpInput(body) {
  if (!isPlainObject(body) || typeof body.method !== 'string' || body.method.length < 1 || body.method.length > 100) {
    return 'methodが必要です';
  }
  if (body.params !== undefined && !isPlainObject(body.params)) {
    return 'paramsはJSONオブジェクトが必要です';
  }
  return null;
}

/**
 * get_powerapps_app パラメータ検証
 */
function validateGetPowerAppsAppParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  return null;
}

/**
 * get_powerapps_state パラメータ検証
 */
function validateGetPowerAppsStateParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  return null;
}

/**
 * update_powerapps_app パラメータ検証
 */
function validateUpdatePowerAppsAppParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  if (!params.updateData || typeof params.updateData !== 'object') {
    return 'updateData（オブジェクト）が必要です';
  }
  return null;
}

/**
 * save_powerapps_app パラメータ検証
 */
function validateSavePowerAppsAppParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  return null;
}

/**
 * publish_powerapps_app パラメータ検証
 */
function validatePublishPowerAppsAppParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  return null;
}

/**
 * get_powerapps_operation_result パラメータ検証
 */
function validateGetPowerAppsOperationResultParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  if (typeof params.operationId !== 'string' || params.operationId.length < 1 || params.operationId.length > 100) {
    return 'operationId（1から100文字の文字列）が必要です';
  }
  return null;
}

module.exports = {
  validatePowerAppsMcpInput,
  validateGetPowerAppsAppParams,
  validateGetPowerAppsStateParams,
  validateUpdatePowerAppsAppParams,
  validateSavePowerAppsAppParams,
  validatePublishPowerAppsAppParams,
  validateGetPowerAppsOperationResultParams
};