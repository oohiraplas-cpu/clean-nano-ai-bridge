const { STATUSES } = require('./taskStore');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateTaskInput(body, { requireTitle = false } = {}) {
  if (!isPlainObject(body)) return 'リクエスト本文はJSONオブジェクトである必要があります';
  if (typeof body.id !== 'string' || body.id.length < 1 || body.id.length > 100) return 'idは1から100文字の文字列が必要です';
  if (requireTitle && (typeof body.title !== 'string' || body.title.length < 1 || body.title.length > 500)) return 'titleは1から500文字の文字列が必要です';
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 500)) return 'titleは500文字以内の文字列が必要です';
  if (body.status !== undefined && !STATUSES.includes(body.status)) return 'statusが不正です';
  if (body.retry_count !== undefined && (!Number.isInteger(body.retry_count) || body.retry_count < 0)) return 'retry_countは0以上の整数が必要です';
  if (body.approval_required !== undefined && typeof body.approval_required !== 'boolean') return 'approval_requiredはbooleanが必要です';
  if (body.userActionRequired !== undefined && typeof body.userActionRequired !== 'boolean') return 'userActionRequiredはbooleanが必要です';
  return null;
}

function validateStatusInput(body) {
  if (!isPlainObject(body)) return 'リクエスト本文はJSONオブジェクトである必要があります';
  if (body.status !== undefined && !STATUSES.includes(body.status)) return 'statusが不正です';
  if (body.retry_count !== undefined && (!Number.isInteger(body.retry_count) || body.retry_count < 0)) return 'retry_countは0以上の整数が必要です';
  if (body.approval_required !== undefined && typeof body.approval_required !== 'boolean') return 'approval_requiredはbooleanが必要です';
  if (body.userActionRequired !== undefined && typeof body.userActionRequired !== 'boolean') return 'userActionRequiredはbooleanが必要です';
  return null;
}

function validateMcpInput(body) {
  if (!isPlainObject(body) || typeof body.method !== 'string' || body.method.length < 1 || body.method.length > 100) return 'methodが必要です';
  if (body.params !== undefined && !isPlainObject(body.params)) return 'paramsはJSONオブジェクトが必要です';
  return null;
}

module.exports = { validateMcpInput, validateStatusInput, validateTaskInput };