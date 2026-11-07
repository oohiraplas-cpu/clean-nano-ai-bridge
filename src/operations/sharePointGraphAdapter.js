'use strict';

// SharePoint READ 用の Microsoft Graph アダプター（読み取り専用）。
// - 接続先は1サイトに固定する（コンストラクタの siteUrl）。
// - トークンは tokenProvider から注入する。未注入（null）の場合は通信せず configured=false とする。
//   既存の SHAREPOINT_* のクライアントシークレット認証は、方針上の最終手段のため本アダプターでは再利用しない。
// - 書き込み系メソッドは持たない。
// - エラーは種別コードだけを返し、応答本文・トークン・URLの秘密部分は含めない。

const { createGraphClient, GraphClientError, mapHttpStatus, GRAPH_BASE } = require('../graph/graphClient');

const DEFAULT_TIMEOUT_MS = 15000;

class SharePointAdapterError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'SharePointAdapterError';
    this.code = code;
    this.status = status || null;
  }
}


function parseSiteUrl(siteUrl) {
  let url;
  try { url = new URL(siteUrl); } catch { throw new Error('siteUrl is not a valid URL'); }
  if (url.protocol !== 'https:') throw new Error('siteUrl must use https');
  if (!url.hostname.endsWith('.sharepoint.com')) throw new Error('siteUrl must be a SharePoint Online host');
  if (!/^\/sites\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error('siteUrl must be a /sites/{name} path');
  return { hostname: url.hostname, sitePath: url.pathname };
}

function createSharePointGraphAdapter({ siteUrl, tokenProvider = null, fetchImpl = globalThis.fetch, graphBase = GRAPH_BASE, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { hostname, sitePath } = parseSiteUrl(siteUrl);
  // 取得元が構成済みと報告する場合のみ configured=true（未構成の提供者は通信せず BLOCKED とする）。
  const configured = typeof tokenProvider === 'function' && tokenProvider.configured !== false;
  let siteIdPromise = null;

  // 共通 Graph クライアントへ委譲する（認証・HTTP・429再試行・分類は graphClient.js に一本化）。
  const client = createGraphClient({ tokenProvider: configured ? tokenProvider : null, fetchImpl, graphBase, timeoutMs });
  const toAdapterError = (error) => (error instanceof GraphClientError ? new SharePointAdapterError(error.code, error.status) : error);
  async function graphGet(pathAndQuery) {
    try {
      return await client.request({ method: 'GET', pathAndQuery });
    } catch (error) {
      throw toAdapterError(error);
    }
  }

  // 書き込み（Lane D）。許可したメソッドと経路だけを通す。応答本文は返さず、作成・更新の識別子のみ返す。
  const WRITE_ALLOWED = Object.freeze({ POST: /^\/sites\/[^/]+\/(lists\/[^/]+\/(columns|items)|permissions)(\/[^/?]+\/fields)?(\?|$)/, PATCH: /^\/sites\/[^/]+\/lists\/[^/]+\/(columns\/[^/?]+|items\/[^/?]+\/fields)(\?|$)/, DELETE: /^\/sites\/[^/]+\/permissions\/[^/?]+(\?|$)/ });

  async function graphWrite(method, pathAndQuery, body) {
    try {
      return await client.request({ method, pathAndQuery, body, allowWrite: (m, p) => Boolean(WRITE_ALLOWED[m] && WRITE_ALLOWED[m].test(p)) });
    } catch (error) {
      throw toAdapterError(error);
    }
  }

  function resolveSiteId() {
    if (!siteIdPromise) {
      siteIdPromise = graphGet(`/sites/${hostname}:${sitePath}?$select=id,displayName,webUrl`)
        .then((site) => {
          if (typeof site.id !== 'string') throw new SharePointAdapterError('UPSTREAM_INVALID_RESPONSE');
          return site.id;
        })
        .catch((error) => { siteIdPromise = null; throw error; });
    }
    return siteIdPromise;
  }

  const encodeId = (value) => encodeURIComponent(String(value));

  return {
    configured,
    siteUrl: `https://${hostname}${sitePath}`,

    async siteGet() {
      const site = await graphGet(`/sites/${hostname}:${sitePath}?$select=id,displayName,webUrl`);
      return { siteId: site.id, displayName: site.displayName || null, webUrl: site.webUrl || null };
    },

    async listsList({ top = 50 } = {}) {
      const siteId = await resolveSiteId();
      const data = await graphGet(`/sites/${encodeId(siteId)}/lists?$select=id,displayName,name,hidden&$top=${Number(top)}`);
      return (data.value || []).map((list) => ({
        listId: list.id, displayName: list.displayName || null, name: list.name || null, hidden: list.hidden === true
      }));
    },

    async listGet({ listId }) {
      const siteId = await resolveSiteId();
      const list = await graphGet(`/sites/${encodeId(siteId)}/lists/${encodeId(listId)}?$select=id,displayName,name,hidden,list`);
      return {
        listId: list.id, displayName: list.displayName || null, name: list.name || null,
        hidden: list.hidden === true, template: list.list?.template || null
      };
    },

    async listSchemaGet({ listId }) {
      const siteId = await resolveSiteId();
      const data = await graphGet(`/sites/${encodeId(siteId)}/lists/${encodeId(listId)}/columns?$select=id,name,displayName,hidden,readOnly,required,columnGroup`);
      return (data.value || []).map((column) => ({
        columnId: column.id,
        internalName: column.name || null,
        displayName: column.displayName || null,
        hidden: column.hidden === true,
        readOnly: column.readOnly === true,
        required: column.required === true,
        columnGroup: column.columnGroup || null
      }));
    },

    async itemGet({ listId, itemId }) {
      const siteId = await resolveSiteId();
      const item = await graphGet(`/sites/${encodeId(siteId)}/lists/${encodeId(listId)}/items/${encodeId(itemId)}?$expand=fields`);
      return { itemId: item.id, fields: item.fields || {} };
    },

    async itemQuery({ listId, top = 50 }) {
      const siteId = await resolveSiteId();
      const data = await graphGet(`/sites/${encodeId(siteId)}/lists/${encodeId(listId)}/items?$expand=fields&$top=${Number(top)}`);
      return (data.value || []).map((item) => ({ itemId: item.id, fields: item.fields || {} }));
    },

    // ---- 書き込み（Lane D）。すべて事前に dry-run・Snapshot・監査を通す前提（operationsMcp 側で強制）。 ----

    async columnCreate({ listId, column }) {
      const siteId = await resolveSiteId();
      const created = await graphWrite('POST', `/sites/${encodeId(siteId)}/lists/${encodeId(listId)}/columns`, column);
      return { columnId: created.id || null, internalName: created.name || column.name };
    },

    async columnUpdate({ listId, columnId, patch }) {
      const siteId = await resolveSiteId();
      await graphWrite('PATCH', `/sites/${encodeId(siteId)}/lists/${encodeId(listId)}/columns/${encodeId(columnId)}`, patch);
      return { columnId };
    },

    async itemCreate({ listId, fields }) {
      const siteId = await resolveSiteId();
      const created = await graphWrite('POST', `/sites/${encodeId(siteId)}/lists/${encodeId(listId)}/items`, { fields });
      return { itemId: created.id || null };
    },

    async itemUpdate({ listId, itemId, fields }) {
      const siteId = await resolveSiteId();
      await graphWrite('PATCH', `/sites/${encodeId(siteId)}/lists/${encodeId(listId)}/items/${encodeId(itemId)}/fields`, fields);
      return { itemId };
    },

    async permissionsGrant({ roles, recipientEmails }) {
      const siteId = await resolveSiteId();
      const created = await graphWrite('POST', `/sites/${encodeId(siteId)}/permissions`, {
        roles,
        recipients: recipientEmails.map((email) => ({ email }))
      });
      return { permissionIds: Array.isArray(created.value) ? created.value.map((p) => p.id) : (created.id ? [created.id] : []) };
    },

    async permissionsRevoke({ permissionId }) {
      const siteId = await resolveSiteId();
      await graphWrite('DELETE', `/sites/${encodeId(siteId)}/permissions/${encodeId(permissionId)}`);
      return { permissionId };
    },

    async permissionsGet() {
      const siteId = await resolveSiteId();
      const data = await graphGet(`/sites/${encodeId(siteId)}/permissions`);
      return (data.value || []).map((permission) => ({
        permissionId: permission.id,
        roles: Array.isArray(permission.roles) ? permission.roles : [],
        grantedToKinds: permission.grantedToIdentitiesV2 ? 'identities' : (permission.grantedTo ? 'identity' : 'link')
      }));
    }
  };
}

module.exports = { createSharePointGraphAdapter, SharePointAdapterError, mapHttpStatus, parseSiteUrl };
