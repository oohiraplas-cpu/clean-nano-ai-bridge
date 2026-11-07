'use strict';

// Entra ID（Microsoft Graph）の READ アダプター（Lane 2）。共通 Graph クライアントを使う。
// - 読み取りのみ。応答は必要項目だけに射影し、資格情報（passwordCredentials / keyCredentials 等）は要求しない・返さない。
// - 件数上限（maxItems）を全一覧に適用し、超過は truncated=true で示す。
// - 権限不足は PERMISSION_DENIED、未構成は BLOCKED（ADAPTER_NOT_CONFIGURED）として呼出元へ返す。
// - OData の文字列は単一引用符をエスケープする。パス要素は encodeURIComponent する。

const { createGraphClient, GraphClientError } = require('../graph/graphClient');

const DEFAULT_MAX_ITEMS = 200;
const MAX_ITEMS_CEILING = 999;

// 操作ごとに必要な Graph 権限（応答の説明用。付与の可否は実環境で確認する）。
const REQUIRED_PERMISSIONS = Object.freeze({
  entra_tenant_get: ['Organization.Read.All'],
  entra_user_search: ['User.ReadBasic.All'],
  entra_user_get: ['User.Read.All'],
  entra_groups_list: ['Group.Read.All'],
  entra_group_get: ['Group.Read.All'],
  entra_licenses_list: ['Organization.Read.All'],
  entra_role_assignments_get: ['RoleManagement.Read.Directory'],
  entra_apps_list: ['Application.Read.All'],
  entra_service_principals_list: ['Application.Read.All'],
  entra_audit_logs_get: ['AuditLog.Read.All']
});

const USER_SELECT = 'id,displayName,userPrincipalName,accountEnabled,usageLocation,department,jobTitle,mail,assignedLicenses';
const GROUP_SELECT = 'id,displayName,mailEnabled,securityEnabled,groupTypes';

const GUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const USER_REF_PATTERN = '^[A-Za-z0-9@._%+-]{1,256}$';
const TOP = { type: 'integer', minimum: 1, maximum: MAX_ITEMS_CEILING };
// action ごとの入力スキーマ（未知の項目は拒否する）。
const READ_ACTION_SCHEMAS = Object.freeze({
  entra_tenant_get: { required: [], additionalProperties: false, properties: {} },
  entra_user_search: { required: ['query'], additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 100 }, top: { ...TOP, maximum: 25 } } },
  entra_user_get: { required: ['userId'], additionalProperties: false, properties: { userId: { type: 'string', pattern: USER_REF_PATTERN } } },
  entra_groups_list: { required: [], additionalProperties: false, properties: { top: TOP } },
  entra_group_get: { required: ['groupId'], additionalProperties: false, properties: { groupId: { type: 'string', pattern: GUID_PATTERN } } },
  entra_licenses_list: { required: [], additionalProperties: false, properties: {} },
  entra_role_assignments_get: { required: ['principalId'], additionalProperties: false, properties: { principalId: { type: 'string', pattern: GUID_PATTERN } } },
  entra_apps_list: { required: [], additionalProperties: false, properties: { top: TOP } },
  entra_service_principals_list: { required: [], additionalProperties: false, properties: { top: TOP } },
  entra_audit_logs_get: { required: [], additionalProperties: false, properties: { days: { type: 'integer', minimum: 1, maximum: 30 }, top: TOP } }
});

function odataString(value) {
  return String(value).replace(/'/g, "''");
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (obj && obj[key] !== undefined) out[key] = obj[key];
  return out;
}

function mapUser(u) {
  return {
    ...pick(u, ['id', 'displayName', 'userPrincipalName', 'accountEnabled', 'usageLocation', 'department', 'jobTitle', 'mail']),
    assignedLicenseSkuIds: Array.isArray(u.assignedLicenses) ? u.assignedLicenses.map((l) => l.skuId).filter(Boolean) : []
  };
}

function mapGroup(g) {
  return { ...pick(g, ['id', 'displayName', 'mailEnabled', 'securityEnabled']), isM365Group: Array.isArray(g.groupTypes) && g.groupTypes.includes('Unified') };
}

function clampTop(value, fallback = 50) {
  const n = Number.isInteger(value) ? value : fallback;
  return Math.min(Math.max(n, 1), MAX_ITEMS_CEILING);
}

function createEntraAdapter({ tokenProvider = null, fetchImpl = globalThis.fetch, graphBase, timeoutMs, maxRetries, sleep } = {}) {
  const configured = typeof tokenProvider === 'function' && tokenProvider.configured !== false;
  const client = createGraphClient({ tokenProvider: configured ? tokenProvider : null, fetchImpl, graphBase, timeoutMs, maxRetries, sleep });

  const get = (pathAndQuery) => client.request({ method: 'GET', pathAndQuery });
  const list = (pathAndQuery, maxItems) => client.getAll(pathAndQuery, { maxItems });

  const handlers = {
    async entra_tenant_get() {
      const data = await get('/organization?$select=id,displayName,verifiedDomains');
      const org = Array.isArray(data.value) ? data.value[0] : data;
      return {
        tenantId: org.id || null,
        displayName: org.displayName || null,
        domains: Array.isArray(org.verifiedDomains) ? org.verifiedDomains.map((d) => d.name).filter(Boolean).slice(0, 50) : []
      };
    },

    async entra_user_search({ query, top }) {
      const q = odataString(query);
      const max = clampTop(top, 25);
      const page = await list(`/users?$filter=${encodeURIComponent(`startswith(displayName,'${q}') or startswith(userPrincipalName,'${q}')`)}&$select=${USER_SELECT}&$top=${max}`, max);
      return { users: page.items.map(mapUser), count: page.items.length, truncated: page.truncated };
    },

    async entra_user_get({ userId }) {
      const u = await get(`/users/${encodeURIComponent(userId)}?$select=${USER_SELECT}`);
      return { user: mapUser(u) };
    },

    async entra_groups_list({ top }) {
      const max = clampTop(top, 50);
      const page = await list(`/groups?$select=${GROUP_SELECT}&$top=${max}`, max);
      return { groups: page.items.map(mapGroup), count: page.items.length, truncated: page.truncated };
    },

    async entra_group_get({ groupId }) {
      const g = await get(`/groups/${encodeURIComponent(groupId)}?$select=${GROUP_SELECT}`);
      return { group: mapGroup(g) };
    },

    async entra_licenses_list() {
      const data = await get('/subscribedSkus?$select=skuId,skuPartNumber,capabilityStatus,consumedUnits,prepaidUnits');
      const skus = (Array.isArray(data.value) ? data.value : []).map((s) => {
        const enabled = Number(s.prepaidUnits?.enabled ?? 0);
        const consumed = Number(s.consumedUnits ?? 0);
        return { skuId: s.skuId, skuPartNumber: s.skuPartNumber || null, capabilityStatus: s.capabilityStatus || null, enabled, consumed, available: Math.max(enabled - consumed, 0) };
      });
      return { skus: skus.slice(0, 500), count: skus.length };
    },

    async entra_role_assignments_get({ principalId }) {
      const data = await get(`/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${odataString(principalId)}'`)}&$select=id,principalId,roleDefinitionId,directoryScopeId`);
      return { assignments: (Array.isArray(data.value) ? data.value : []).slice(0, 200).map((a) => pick(a, ['id', 'principalId', 'roleDefinitionId', 'directoryScopeId'])) };
    },

    async entra_apps_list({ top }) {
      const max = clampTop(top, 50);
      const page = await list(`/applications?$select=id,appId,displayName,signInAudience&$top=${max}`, max);
      return { applications: page.items.map((a) => pick(a, ['id', 'appId', 'displayName', 'signInAudience'])), count: page.items.length, truncated: page.truncated };
    },

    async entra_service_principals_list({ top }) {
      const max = clampTop(top, 50);
      const page = await list(`/servicePrincipals?$select=id,appId,displayName,servicePrincipalType,accountEnabled&$top=${max}`, max);
      return { servicePrincipals: page.items.map((s) => pick(s, ['id', 'appId', 'displayName', 'servicePrincipalType', 'accountEnabled'])), count: page.items.length, truncated: page.truncated };
    },

    async entra_audit_logs_get({ days, top }) {
      const max = clampTop(top, 50);
      const since = new Date(Date.now() - (days || 7) * 86400000).toISOString();
      const page = await list(`/auditLogs/directoryAudits?$filter=${encodeURIComponent(`activityDateTime ge ${since}`)}&$top=${max}`, max);
      return {
        since,
        events: page.items.slice(0, max).map((e) => ({
          id: e.id, activityDateTime: e.activityDateTime, activityDisplayName: e.activityDisplayName || null,
          category: e.category || null, result: e.result || null, operationType: e.operationType || null
        })),
        count: page.items.length, truncated: page.truncated
      };
    }
  };

  return {
    configured,
    operations: Object.freeze(Object.keys(handlers)),
    requiredPermissions: REQUIRED_PERMISSIONS,
    // 内部の Graph 呼び出しを隠して、操作名と引数だけを受け取る。
    call: (name, args) => {
      if (!configured) throw new GraphClientError('AUTH_NOT_CONFIGURED');
      return handlers[name](args);
    },
    // 書込み系（entraWrite.js）から共通クライアントを使うための口。
    client,
    get,
    list
  };
}

// 共通エラーを、公開応答の状態・理由コードへ変換する。値は含めない。
function classifyGraphError(error, operation) {
  if (error instanceof GraphClientError) {
    if (error.code === 'AUTH_NOT_CONFIGURED') return { status: 'BLOCKED', reasonCode: 'ADAPTER_NOT_CONFIGURED', adapter: 'entra', executed: false, message: 'Entra ID（Graph）の認証が未構成のため、実環境での読取は行えません（未確認）。', nextStep: 'Managed Identity または証明書で Graph の認証を構成する。' };
    if (error.code === 'PERMISSION_DENIED') return { status: 'FAIL', reasonCode: 'PERMISSION_DENIED', executed: false, message: 'Entra ID の権限が不足しています。', requiredPermissions: REQUIRED_PERMISSIONS[operation] || [] };
    const messages = {
      AUTH_FAILED: 'Entra ID（Graph）の認証に失敗しました。',
      TARGET_NOT_FOUND: '対象が見つかりません。',
      RATE_LIMITED: 'Graph 側で要求が制限されています。時間をおいて再試行してください。',
      UPSTREAM_ERROR: 'Graph 側でエラーが発生しました。',
      UPSTREAM_UNREACHABLE: 'Graph に接続できませんでした。',
      UPSTREAM_INVALID_RESPONSE: 'Graph の応答を解釈できませんでした。',
      UPSTREAM_REJECTED: 'Graph が要求を拒否しました。',
      WRITE_PATH_REJECTED: '許可されていない書込み経路のため拒否しました。'
    };
    return { status: 'FAIL', reasonCode: error.code, executed: false, message: messages[error.code] || 'Entra ID の処理に失敗しました。' };
  }
  return { status: 'FAIL', reasonCode: 'INTERNAL_ERROR', executed: false, message: '内部エラーが発生しました。' };
}

module.exports = { createEntraAdapter, classifyGraphError, REQUIRED_PERMISSIONS, READ_ACTION_SCHEMAS, odataString, mapUser, mapGroup, DEFAULT_MAX_ITEMS };
