/**
 * Power Apps関連のリクエスト入力検証
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function plain(params) {
  return isPlainObject(params) ? null : 'paramsはJSONオブジェクトである必要があります';
}
function validatePowerAppsMcpInput(body) {
  if (!isPlainObject(body) || typeof body.method !== 'string' || body.method.length < 1 || body.method.length > 100) return 'methodが必要です';
  if (body.params !== undefined && !isPlainObject(body.params)) return 'paramsはJSONオブジェクトが必要です';
  return null;
}
const validateGetPowerAppsAppParams = plain;
const validateGetPowerAppsStateParams = plain;
function validateUpdatePowerAppsAppParams(params) {
  if (!isPlainObject(params)) return plain(params);
  if (typeof params.relativePath !== 'string' || !params.relativePath.trim()) return 'relativePathが必要です';
  if (typeof params.content !== 'string') return 'content（文字列）が必要です';
  return null;
}
const validateSavePowerAppsAppParams = plain;
const validatePublishPowerAppsAppParams = plain;
function validateGetPowerAppsOperationResultParams(params) {
  if (!isPlainObject(params)) return plain(params);
  if (typeof params.operationId !== 'string' || params.operationId.length < 1 || params.operationId.length > 100) return 'operationId（1から100文字の文字列）が必要です';
  return null;
}
function validateGetPowerAppsSourceParams(params) {
  if (!isPlainObject(params)) return plain(params);
  if (typeof params.relativePath !== 'string' || !params.relativePath.trim()) return 'relativePathが必要です';
  return null;
}
module.exports = {
  validatePowerAppsMcpInput,
  validateGetPowerAppsAppParams,
  validateGetPowerAppsStateParams,
  validateUpdatePowerAppsAppParams,
  validateSavePowerAppsAppParams,
  validatePublishPowerAppsAppParams,
  validateGetPowerAppsOperationResultParams,
  validateGetPowerAppsSourceParams
};
