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

function validateGetSharePointColumnsParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  if (params.listId !== undefined && typeof params.listId !== 'string') return 'listIdは文字列である必要があります';
  if (params.listName !== undefined && typeof params.listName !== 'string') return 'listNameは文字列である必要があります';
  if (!params.listId && !params.listName) return 'listIdまたはlistNameのいずれかが必要です';
  if (params.siteId !== undefined && typeof params.siteId !== 'string') return 'siteIdは文字列である必要があります';
  return null;
}

function validateEnsureSharePointColumnsParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  if (!params.listId && !params.listName) return 'listIdまたはlistNameのいずれかが必要です';
  if (!Array.isArray(params.columns) || params.columns.length < 1) return 'columnsは1件以上必要です';
  if (params.approvedByHuman !== true) return 'approvedByHuman:trueが必要です（人間承認が必要な操作です）';
  const allowedTypes = new Set(['text', 'number', 'dateTime', 'boolean', 'choice']);
  for (const column of params.columns) {
    if (!isPlainObject(column)) return 'columnsの各要素はJSONオブジェクトである必要があります';
    if (typeof column.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(column.name)) return 'column.nameは英字開始の英数字/アンダースコアのみ使用できます';
    if (typeof column.displayName !== 'string' || !column.displayName.trim()) return 'column.displayNameが必要です';
    if (!allowedTypes.has(column.type)) return 'column.typeはtext/number/dateTime/boolean/choiceのいずれかです';
    if (column.type === 'choice' && (!Array.isArray(column.choices) || column.choices.length < 1)) return 'choice列にはchoicesが必要です';
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


const { PERMISSION_TARGET_TYPES, PRINCIPAL_TYPES } = require('./permissionsService');

// 新ツール用: inputSchemaのadditionalProperties:falseを実行時にも強制する。
function unknownProperty(params, allowed) {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  return unknown.length ? `未対応のプロパティです: ${unknown.join(', ')}` : null;
}

function optionalString(params, key, { max = 200 } = {}) {
  if (params[key] === undefined) return null;
  if (typeof params[key] !== 'string' || !params[key].trim()) return `${key}は空でない文字列である必要があります`;
  if (params[key].length > max) return `${key}は${max}文字以内である必要があります`;
  return null;
}

function requiredString(params, key, { max = 200 } = {}) {
  if (typeof params[key] !== 'string' || !params[key].trim()) return `${key}が必要です（空でない文字列）`;
  if (params[key].length > max) return `${key}は${max}文字以内である必要があります`;
  return null;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function validateDeployToTestParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['branch', 'environment', 'ref']);
  if (unknown) return unknown;
  const error = requiredString(params, 'branch') || optionalString(params, 'environment');
  if (error) return error;
  if (params.ref !== undefined && (typeof params.ref !== 'string' || !SHA_PATTERN.test(params.ref))) return 'refは40桁のコミットSHA（16進）である必要があります';
  return null;
}

function validateVerifyDeploymentParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['environment', 'deploymentId', 'expectedVersion']);
  if (unknown) return unknown;
  return optionalString(params, 'environment') || optionalString(params, 'deploymentId') || optionalString(params, 'expectedVersion');
}

function validateGetDeploymentLogsParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['environment', 'deploymentId', 'runId', 'limit', 'includeJobLogs']);
  if (unknown) return unknown;
  const error = optionalString(params, 'environment') || optionalString(params, 'deploymentId');
  if (error) return error;
  if (params.runId !== undefined && (!Number.isInteger(params.runId) || params.runId < 1)) return 'runIdは1以上の整数である必要があります';
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 20)) return 'limitは1から20の整数である必要があります';
  if (params.includeJobLogs !== undefined && typeof params.includeJobLogs !== 'boolean') return 'includeJobLogsはbooleanである必要があります';
  if (params.runId !== undefined && params.deploymentId !== undefined) return 'runIdとdeploymentIdは同時に指定できません';
  return null;
}

function validateRollbackDeploymentParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['environment', 'targetDeploymentId', 'approvedByHuman']);
  if (unknown) return unknown;
  const error = requiredString(params, 'targetDeploymentId') || optionalString(params, 'environment');
  if (error) return error;
  // 本番かどうかは設定を知るServiceが判定する（本番ならapprovedByHuman:trueが必須）。
  if (params.approvedByHuman !== undefined && typeof params.approvedByHuman !== 'boolean') return 'approvedByHumanはbooleanである必要があります';
  return null;
}

function validateGetPermissionsParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['targetType', 'principalId']);
  if (unknown) return unknown;
  if (!PERMISSION_TARGET_TYPES.includes(params.targetType)) return `targetTypeは${PERMISSION_TARGET_TYPES.join(' / ')}のいずれかである必要があります`;
  if (params.principalId !== undefined) {
    const error = optionalString(params, 'principalId');
    if (error) return error;
  }
  if (params.targetType === 'dataverse_user_roles' && params.principalId === undefined) return 'dataverse_user_rolesではprincipalId（systemuserのGUID）が必要です';
  return null;
}

function validateUpdatePermissionsParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['targetType', 'action', 'principalId', 'principalType', 'roleName', 'approvedByHuman']);
  if (unknown) return unknown;
  if (!PERMISSION_TARGET_TYPES.includes(params.targetType)) return `targetTypeは${PERMISSION_TARGET_TYPES.join(' / ')}のいずれかである必要があります`;
  if (!['grant', 'revoke'].includes(params.action)) return 'actionはgrantまたはrevokeである必要があります';
  const error = requiredString(params, 'principalId') || requiredString(params, 'roleName');
  if (error) return error;
  if (!PRINCIPAL_TYPES.includes(params.principalType)) return `principalTypeは${PRINCIPAL_TYPES.join(' / ')}のいずれかである必要があります`;
  if (params.approvedByHuman !== true) return 'approvedByHuman:trueが必要です（人間承認が必要な操作です）';
  return null;
}

function validateLockUserInfoParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['user', 'passkey']);
  if (unknown) return unknown;
  if (!isPlainObject(params.user)) return 'userはJSONオブジェクトである必要があります';
  if (typeof params.user.email !== 'string' || !params.user.email.trim()) return 'user.emailが必要です';
  const error = requiredString(params, 'passkey');
  if (error) return error;
  if (params.passkey.length < 32) return 'passkeyは32文字以上である必要があります';
  return null;
}

function validateValidatePasskeyParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['passkey', 'user']);
  if (unknown) return unknown;
  const error = requiredString(params, 'passkey');
  if (error) return error;
  if (!isPlainObject(params.user)) return 'userはJSONオブジェクトである必要があります';
  if (typeof params.user.passkeyHash !== 'string') return 'user.passkeyHashが必要です';
  return null;
}

function validateGetUserLockStatusParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['user']);
  if (unknown) return unknown;
  if (!isPlainObject(params.user)) return 'userはJSONオブジェクトである必要があります';
  return null;
}

function validateCanViewUserInfoParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['targetUser', 'currentUserEmail']);
  if (unknown) return unknown;
  if (!isPlainObject(params.targetUser)) return 'targetUserはJSONオブジェクトである必要があります';
  const error = requiredString(params, 'currentUserEmail');
  if (error) return error;
  return null;
}

function validateCanEditUserInfoParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['targetUser', 'currentUserEmail', 'passkey']);
  if (unknown) return unknown;
  if (!isPlainObject(params.targetUser)) return 'targetUserはJSONオブジェクトである必要があります';
  const error = requiredString(params, 'currentUserEmail');
  if (error) return error;
  if (params.passkey !== undefined && typeof params.passkey !== 'string') return 'passkeyは文字列である必要があります';
  return null;
}

function validateCanDeleteUserInfoParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['targetUser', 'currentUserEmail']);
  if (unknown) return unknown;
  if (!isPlainObject(params.targetUser)) return 'targetUserはJSONオブジェクトである必要があります';
  const error = requiredString(params, 'currentUserEmail');
  if (error) return error;
  return null;
}

function validateGenerateUIControlStateParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['user', 'currentUserEmail']);
  if (unknown) return unknown;
  if (!isPlainObject(params.user)) return 'userはJSONオブジェクトである必要があります';
  const error = requiredString(params, 'currentUserEmail');
  if (error) return error;
  return null;
}

function validatePrepareExecutionPackageParams(params) {
  if (!isPlainObject(params)) return 'paramsはJSONオブジェクトである必要があります';
  const unknown = unknownProperty(params, ['appName', 'objective', 'isolatedCommit']);
  if (unknown) return unknown;
  const appNameError = requiredString(params, 'appName');
  if (appNameError) return appNameError;
  const objectiveError = optionalString(params, 'objective', { max: 500 });
  if (objectiveError) return objectiveError;
  if (params.isolatedCommit !== undefined) {
    const SHA_PATTERN = /^[0-9a-f]{40}$/i;
    if (typeof params.isolatedCommit !== 'string' || !SHA_PATTERN.test(params.isolatedCommit)) {
      return 'isolatedCommitは40文字の16進数SHAである必要があります';
    }
  }
  return null;
}

module.exports = {
  validateDeployToTestParams,
  validateVerifyDeploymentParams,
  validateGetDeploymentLogsParams,
  validateRollbackDeploymentParams,
  validateGetPermissionsParams,
  validateUpdatePermissionsParams,
  validateGetSharePointListParams,
  validateGetSharePointColumnsParams,
  validateEnsureSharePointColumnsParams,
  validateRunPowerAutomateFlowParams,
  validateCreateEmployeeLedgerEntryParams,
  validateUpdateEmployeeLedgerEntryParams,
  validateLockUserInfoParams,
  validateValidatePasskeyParams,
  validateGetUserLockStatusParams,
  validateCanViewUserInfoParams,
  validateCanEditUserInfoParams,
  validateCanDeleteUserInfoParams,
  validateGenerateUIControlStateParams,
  validatePrepareExecutionPackageParams
};
