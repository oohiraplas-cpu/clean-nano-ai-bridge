'use strict';

// SharePoint READ 用の Microsoft Graph アダプター（読み取り専用）。
// - 接続先は1サイトに固定する（コンストラクタの siteUrl）。
// - トークンは tokenProvider から注入する。未注入（null）の場合は通信せず configured=false とする。
//   既存の SHAREPOINT_* のクライアントシークレット認証は、方針上の最終手段のため本アダプターでは再利用しない。
// - 書き込み系メソッドは持たない。
// - エラーは種別コードだけを返し、応答本文・トークン・URLの秘密部分は含めない。

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TIMEOUT_MS = 15000;

class SharePointAdapterError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'SharePointAdapterError';
    this.code = code;
    this.status = status || null;
  }
}

function mapHttpStatus(status) {
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'TARGET_NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'UPSTREAM_REJECTED';
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

  async function graphGet(pathAndQuery) {
    if (!configured) throw new SharePointAdapterError('AUTH_NOT_CONFIGURED');
    let token;
    try { token = await tokenProvider(); } catch (error) {
      // 取得元が返した種別コード（AUTH_NOT_CONFIGURED など）はそのまま伝える。値は含めない。
      const code = typeof error?.code === 'string' && /^AUTH_[A-Z_]+$/.test(error.code) ? error.code : 'AUTH_FAILED';
      throw new SharePointAdapterError(code);
    }
    if (typeof token !== 'string' || token.length === 0) throw new SharePointAdapterError('AUTH_FAILED');
    let response;
    try {
      response = await fetchImpl(`${graphBase}${pathAndQuery}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new SharePointAdapterError('UPSTREAM_UNREACHABLE');
    }
    if (!response.ok) throw new SharePointAdapterError(mapHttpStatus(response.status), response.status);
    try { return await response.json(); } catch { throw new SharePointAdapterError('UPSTREAM_INVALID_RESPONSE'); }
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
