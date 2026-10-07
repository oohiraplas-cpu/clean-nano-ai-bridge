/**
 * Power Apps関連のリクエスト入力検証
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function plain(params) {
  return isPlainObject(params) ? null : 'paramsはJSONオブジェクトである必要があります';
}

// 新ツール用: inputSchemaのadditionalProperties:falseを実行時にも強制する。
function unknownProperty(params, allowed) {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  return unknown.length ? `未対応のプロパティです: ${unknown.join(', ')}` : null;
}

// get_powerapps_sourceが返したbranchを渡して、正本branchとの一致確認に使う（任意・後方互換）。
function optionalBranch(params) {
  if (params.branch !== undefined && (typeof params.branch !== 'string' || !params.branch.trim())) return 'branchは空でない文字列である必要があります';
  if (params.stateContext !== undefined && !isPlainObject(params.stateContext)) return 'stateContextはJSONオブジェクトである必要があります';
  return null;
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
  if (isPlainObject(params.updateData)) {
    const keys = Object.keys(params.updateData);
    if (!keys.length || keys.some((key) => !['description', 'commitMessage'].includes(key))) return 'updateDataで指定できるのはdescriptionおよびcommitMessageのみです';
    if (params.updateData.description !== undefined && typeof params.updateData.description !== 'string') return 'descriptionは文字列である必要があります';
    if (params.updateData.commitMessage !== undefined && typeof params.updateData.commitMessage !== 'string') return 'commitMessageは文字列である必要があります';
    return null;
  }
  if (typeof params.relativePath !== 'string' || !params.relativePath.trim()) return 'relativePathが必要です';
  if (typeof params.content !== 'string') return 'content（文字列）が必要です';
  return optionalBranch(params);
}
function validateSavePowerAppsAppParams(params) {
  if (!isPlainObject(params)) return plain(params);
  return optionalBranch(params);
}
function validatePublishPowerAppsAppParams(params) {
  if (!isPlainObject(params)) return plain(params);
  return optionalBranch(params);
}
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

function stringOrError(value, name, { max = 300 } = {}) {
  if (typeof value !== 'string' || !value.trim()) return `${name}が必要です（空でない文字列）`;
  if (value.length > max) return `${name}は${max}文字以内である必要があります`;
  return null;
}

function validateValidatePowerAppsChangeParams(params) {
  if (!isPlainObject(params)) return plain(params);
  const unknown = unknownProperty(params, ['branch', 'relativePath', 'content', 'currentContent', 'currentExists', 'delete', 'create', 'allowLargeDiff']);
  if (unknown) return unknown;
  const required = stringOrError(params.branch, 'branch') || stringOrError(params.relativePath, 'relativePath');
  if (required) return required;
  for (const key of ['content', 'currentContent']) {
    if (params[key] !== undefined && typeof params[key] !== 'string') return `${key}は文字列である必要があります`;
  }
  for (const key of ['currentExists', 'delete', 'create', 'allowLargeDiff']) {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') return `${key}はbooleanである必要があります`;
  }
  return null;
}

function validateRunPowerAppsTestsParams(params) {
  if (!isPlainObject(params)) return plain(params);
  const unknown = unknownProperty(params, ['files', 'knownScreens', 'knownDataSources']);
  if (unknown) return unknown;
  if (!Array.isArray(params.files) || params.files.length < 1) return 'filesは1件以上の配列が必要です';
  if (params.files.length > 50) return 'filesは50件以内である必要があります';
  for (const file of params.files) {
    if (!isPlainObject(file)) return 'filesの各要素はJSONオブジェクトである必要があります';
    const fileUnknown = unknownProperty(file, ['relativePath', 'content', 'delete']);
    if (fileUnknown) return `files要素: ${fileUnknown}`;
    const pathError = stringOrError(file.relativePath, 'files[].relativePath');
    if (pathError) return pathError;
    if (file.delete !== undefined && typeof file.delete !== 'boolean') return 'files[].deleteはbooleanである必要があります';
    if (file.content !== undefined && typeof file.content !== 'string') return 'files[].contentは文字列である必要があります';
    const isDelete = file.delete === true;
    if (isDelete && file.content !== undefined) return 'files[]でdelete:trueとcontentは同時に指定できません';
    if (!isDelete && file.content === undefined) return 'files[]にはcontent（文字列）またはdelete:trueが必要です';
  }
  for (const key of ['knownScreens', 'knownDataSources']) {
    const list = params[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 500 || list.some((item) => typeof item !== 'string' || !item.trim())) {
      return `${key}は空でない文字列の配列（500件以内）である必要があります`;
    }
  }
  return null;
}

function validateVerifySaveResultParams(params) {
  if (!isPlainObject(params)) return plain(params);
  const unknown = unknownProperty(params, ['relativePath', 'branch', 'expectedSha', 'expectedContent']);
  if (unknown) return unknown;
  const pathError = stringOrError(params.relativePath, 'relativePath');
  if (pathError) return pathError;
  if (params.branch !== undefined && (typeof params.branch !== 'string' || !params.branch.trim())) return 'branchは空でない文字列である必要があります';
  if (params.expectedSha !== undefined && (typeof params.expectedSha !== 'string' || !/^[0-9a-f]{40}$/i.test(params.expectedSha))) return 'expectedShaは40桁の16進文字列である必要があります';
  if (params.expectedContent !== undefined && typeof params.expectedContent !== 'string') return 'expectedContentは文字列である必要があります';
  if (params.expectedSha === undefined && params.expectedContent === undefined) return 'expectedShaまたはexpectedContentのいずれかが必要です';
  return null;
}

module.exports = {
  validateValidatePowerAppsChangeParams,
  validateRunPowerAppsTestsParams,
  validateVerifySaveResultParams,
  validatePowerAppsMcpInput,
  validateGetPowerAppsAppParams,
  validateGetPowerAppsStateParams,
  validateUpdatePowerAppsAppParams,
  validateSavePowerAppsAppParams,
  validatePublishPowerAppsAppParams,
  validateGetPowerAppsOperationResultParams,
  validateGetPowerAppsSourceParams
};
