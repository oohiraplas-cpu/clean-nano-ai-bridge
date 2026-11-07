'use strict';

// Power Platform READ アダプター（Lane 3）。読み取りのみ。
// - 対象環境は 4d0aab59-43ec-ecf1-a9d1-869f2517adbb に固定する（環境一覧のみ全環境を対象にする）。
//   他の環境IDを指定した操作は ENVIRONMENT_NOT_ALLOWED で拒否する。
// - 環境変数は名前・型・現在値の有無だけを返し、値は返さない。
// - connection は接続名・コネクタ・状態だけを返し、認証パラメータ（properties.connectionParameters 等）は読まない・返さない。
// - DLP は読取のみ。Premium／新規課金が必要な経路は採用しない（有料の作成・購入の API は持たない）。
// - Dataverse の操作は環境の instanceUrl を管理 API から取得してから行う。Dataverse 未プロビジョニングは FAIL。

const { createGraphClient, GraphClientError } = require('../graph/graphClient');

const PINNED_ENVIRONMENT_ID = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const ADMIN_BASE = 'https://api.bap.microsoft.com';
const ADMIN_API_VERSION = '2021-04-01';
const POWERAPPS_API_VERSION = '2016-11-01';
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CONNECTION_NAME_RE = /^[A-Za-z0-9-]{1,100}$/;

const REQUIRED_PERMISSIONS = Object.freeze({
  pp_environments_list: ['Power Platform 管理者（Environment 読取）'],
  pp_environment_get: ['Power Platform 管理者（Environment 読取）'],
  pp_connectors_list: ['Power Platform 管理者（Connector 読取）'],
  pp_connections_list: ['Power Platform 管理者（Connection 読取）'],
  pp_connection_test: ['Power Platform 管理者（Connection 読取）'],
  solutions_list: ['Dataverse 読取（対象環境のシステム管理者または閲覧者）'],
  connection_references_get: ['Dataverse 読取（対象環境）'],
  environment_variables_get: ['Dataverse 読取（対象環境）'],
  pp_dlp_policies_list: ['Power Platform 管理者（DLP 読取）']
});

const TOP_PROP = { type: 'integer', minimum: 1, maximum: 250 };
// action ごとの入力スキーマ（environmentId は受け付けない。対象は固定）。
const READ_ACTION_SCHEMAS = Object.freeze({
  pp_environments_list: { required: [], additionalProperties: false, properties: {} },
  pp_environment_get: { required: [], additionalProperties: false, properties: {} },
  pp_connectors_list: { required: [], additionalProperties: false, properties: { top: TOP_PROP } },
  pp_connections_list: { required: [], additionalProperties: false, properties: { top: TOP_PROP } },
  pp_connection_test: { required: ['connectionName'], additionalProperties: false, properties: { connectionName: { type: 'string', pattern: '^[A-Za-z0-9-]{1,100}$' } } },
  solutions_list: { required: [], additionalProperties: false, properties: {} },
  connection_references_get: { required: [], additionalProperties: false, properties: {} },
  environment_variables_get: { required: [], additionalProperties: false, properties: {} },
  pp_dlp_policies_list: { required: [], additionalProperties: false, properties: {} }
});

function lastSegment(id) {
  return typeof id === 'string' ? id.split('/').filter(Boolean).pop() || null : null;
}

// tokenFor(audience) は資格情報の提供者（graphAuth 互換の provider）を返す。未構成なら configured=false。
function createPowerPlatformAdapter({ tokenFor = () => null, fetchImpl = globalThis.fetch, adminBase = ADMIN_BASE, timeoutMs, maxRetries, sleep } = {}) {
  const adminProvider = tokenFor(adminBase);
  const adminConfigured = typeof adminProvider === 'function' && adminProvider.configured !== false;
  const admin = createGraphClient({ tokenProvider: adminConfigured ? adminProvider : null, fetchImpl, graphBase: adminBase, timeoutMs, maxRetries, sleep });
  const envPath = `/providers/Microsoft.PowerApps/scopes/admin/environments/${PINNED_ENVIRONMENT_ID}`;

  let metaPromise = null;
  async function environmentMeta() {
    if (!metaPromise) {
      metaPromise = admin.request({ method: 'GET', pathAndQuery: `/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${PINNED_ENVIRONMENT_ID}?api-version=${ADMIN_API_VERSION}` })
        .catch((error) => { metaPromise = null; throw error; });
    }
    return metaPromise;
  }

  // Dataverse（instanceUrl）用の共通クライアントを、環境メタデータに基づいて作る。
  async function dataverse() {
    const meta = await environmentMeta();
    const instanceUrl = meta?.properties?.linkedEnvironmentMetadata?.instanceUrl || null;
    if (!instanceUrl) return { error: 'DATAVERSE_NOT_PROVISIONED' };
    const provider = tokenFor(instanceUrl);
    if (!(typeof provider === 'function' && provider.configured !== false)) return { error: 'AUTH_NOT_CONFIGURED' };
    return { client: createGraphClient({ tokenProvider: provider, fetchImpl, graphBase: instanceUrl, timeoutMs, maxRetries, sleep }) };
  }

  const handlers = {
    async pp_environments_list() {
      const data = await admin.request({ pathAndQuery: `/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=${ADMIN_API_VERSION}` });
      return { environments: (data.value || []).slice(0, 200).map((e) => ({
        environmentId: e.name, displayName: e.properties?.displayName || null, location: e.location || null,
        environmentType: e.properties?.environmentSku || null, isPinnedTarget: e.name === PINNED_ENVIRONMENT_ID
      })) };
    },
    async pp_environment_get() {
      const meta = await environmentMeta();
      return { environmentId: PINNED_ENVIRONMENT_ID, displayName: meta.properties?.displayName || null, location: meta.location || null, dataverseProvisioned: Boolean(meta.properties?.linkedEnvironmentMetadata?.instanceUrl) };
    },
    async pp_connectors_list({ top }) {
      const data = await admin.request({ pathAndQuery: `${envPath}/apis?api-version=${POWERAPPS_API_VERSION}&$top=${Math.min(top || 100, 250)}` });
      return { connectors: (data.value || []).slice(0, 250).map((c) => ({
        connectorName: c.name, displayName: c.properties?.displayName || null, publisher: c.properties?.publisher || null,
        tier: c.properties?.tier || null, isCustom: c.properties?.isCustomApi === true
      })) };
    },
    async pp_connections_list({ top }) {
      const data = await admin.request({ pathAndQuery: `${envPath}/connections?api-version=${POWERAPPS_API_VERSION}&$top=${Math.min(top || 100, 250)}` });
      return { connections: (data.value || []).slice(0, 250).map((c) => ({
        connectionName: c.name, displayName: c.properties?.displayName || null,
        connectorName: lastSegment(c.properties?.apiId), status: c.properties?.statuses?.[0]?.status || null,
        createdAt: c.properties?.createdTime || null
      })) };
    },
    async pp_connection_test({ connectionName }) {
      if (!CONNECTION_NAME_RE.test(connectionName)) throw new GraphClientError('VALIDATION_FAILED');
      const c = await admin.request({ pathAndQuery: `${envPath}/connections/${encodeURIComponent(connectionName)}?api-version=${POWERAPPS_API_VERSION}` });
      const status = c.properties?.statuses?.[0]?.status || null;
      return { connectionName, status, connected: status === 'Connected', connectorName: lastSegment(c.properties?.apiId) };
    },
    async solutions_list() {
      const dv = await dataverse();
      if (dv.error) return { dataverseError: dv.error };
      const data = await dv.client.request({ pathAndQuery: '/api/data/v9.2/solutions?$select=uniquename,friendlyname,version,ismanaged&$filter=isvisible eq true&$top=200' });
      return { solutions: (data.value || []).map((s) => ({ uniqueName: s.uniquename, friendlyName: s.friendlyname || null, version: s.version || null, managed: s.ismanaged === true })) };
    },
    async connection_references_get() {
      const dv = await dataverse();
      if (dv.error) return { dataverseError: dv.error };
      const data = await dv.client.request({ pathAndQuery: '/api/data/v9.2/connectionreferences?$select=connectionreferencelogicalname,connectionreferencedisplayname,connectorid,_connectionid_value&$top=200' });
      return { connectionReferences: (data.value || []).map((r) => ({
        logicalName: r.connectionreferencelogicalname, displayName: r.connectionreferencedisplayname || null,
        connectorId: lastSegment(r.connectorid), bound: Boolean(r._connectionid_value)
      })) };
    },
    async environment_variables_get() {
      const dv = await dataverse();
      if (dv.error) return { dataverseError: dv.error };
      const defs = await dv.client.request({ pathAndQuery: '/api/data/v9.2/environmentvariabledefinitions?$select=schemaname,displayname,type&$top=200' });
      const vals = await dv.client.request({ pathAndQuery: '/api/data/v9.2/environmentvariablevalues?$select=_environmentvariabledefinitionid_value&$top=500' });
      const withValue = new Set((vals.value || []).map((v) => v._environmentvariabledefinitionid_value).filter(Boolean));
      // 値そのものは取得の射影に含めない（defs の defaultvalue / vals の value は要求しない）。
      return { variables: (defs.value || []).map((d) => ({
        schemaName: d.schemaname, displayName: d.displayname || null, type: d.type ?? null,
        hasCurrentValue: withValue.has(d.environmentvariabledefinitionid)
      })) };
    },
    async pp_dlp_policies_list() {
      const data = await admin.request({ pathAndQuery: `/providers/Microsoft.BusinessAppPlatform/scopes/admin/policies?api-version=2016-11-01` });
      return { policies: (data.value || []).slice(0, 200).map((p) => ({
        policyId: p.name, displayName: p.properties?.displayName || null,
        environmentType: p.properties?.environmentType || null,
        connectorGroupCounts: {
          confidential: (p.properties?.connectorGroups?.Confidential || []).length,
          general: (p.properties?.connectorGroups?.General || []).length,
          blocked: (p.properties?.connectorGroups?.Blocked || []).length
        }
      })) };
    }
  };

  const READ_ONLY_HANDLER_NAMES = Object.freeze(Object.keys(handlers));

  async function call(name, args = {}) {
    if (!READ_ONLY_HANDLER_NAMES.includes(name)) throw new GraphClientError('WRITE_PATH_REJECTED');
    if (!adminConfigured) throw new GraphClientError('AUTH_NOT_CONFIGURED');
    return handlers[name](args);
  }

  return { configured: adminConfigured, operations: READ_ONLY_HANDLER_NAMES, requiredPermissions: REQUIRED_PERMISSIONS, pinnedEnvironmentId: PINNED_ENVIRONMENT_ID, call, environmentIdPattern: GUID_RE };
}

module.exports = { createPowerPlatformAdapter, PINNED_ENVIRONMENT_ID, REQUIRED_PERMISSIONS, READ_ACTION_SCHEMAS, GUID_RE };
