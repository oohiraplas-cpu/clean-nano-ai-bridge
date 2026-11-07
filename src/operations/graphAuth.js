'use strict';

// Microsoft Graph 用のトークン取得境界（Lane B）。
// 優先順: Managed Identity → 証明書 → 委任OAuth。
// - 各取得元は「構成済みか」と「取得処理」を持つ。構成は環境変数の『有無』だけで判定し、値は返さない。
// - 構成済みの取得元が無ければ AUTH_NOT_CONFIGURED（BLOCKED候補）。通信はしない。
// - トークンは応答・ログ・監査へ出さない。失効前の一定時間はキャッシュする。
// - 証明書・委任の署名/交換処理は実資格情報の検証が必要なため、注入された acquireFn でのみ動く（既定は未構成）。

const GRAPH_RESOURCE = 'https://graph.microsoft.com';
const IDENTITY_API_VERSION = '2019-08-01';
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

class GraphAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GraphAuthError';
    this.code = code;
  }
}

// App Service の Managed Identity（IDENTITY_ENDPOINT / IDENTITY_HEADER）。
function createManagedIdentitySource({ identityEndpoint = '', identityHeader = '', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const configured = Boolean(identityEndpoint && identityHeader);
  let cached = null;

  async function acquire() {
    if (!configured) throw new GraphAuthError('AUTH_NOT_CONFIGURED');
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached.token;
    const url = `${identityEndpoint}${identityEndpoint.includes('?') ? '&' : '?'}resource=${encodeURIComponent(GRAPH_RESOURCE)}&api-version=${IDENTITY_API_VERSION}`;
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { 'X-IDENTITY-HEADER': identityHeader, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    } catch {
      throw new GraphAuthError('AUTH_UNREACHABLE');
    }
    if (!response.ok) throw new GraphAuthError('AUTH_FAILED');
    let body;
    try { body = await response.json(); } catch { throw new GraphAuthError('AUTH_FAILED'); }
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) throw new GraphAuthError('AUTH_FAILED');
    const expiresOn = Number(body.expires_on);
    const expiresAt = Number.isFinite(expiresOn) ? expiresOn * 1000 : now() + 5 * 60 * 1000;
    cached = { token: body.access_token, expiresAt };
    return body.access_token;
  }

  return { name: 'managedIdentity', configured, acquire };
}

// 証明書・委任は、資格情報の識別子が揃い、かつ取得処理が注入された場合のみ構成済みとなる。
function createInjectedSource({ name, identifiers = {}, acquireFn = null }) {
  const identifiersPresent = Object.values(identifiers).every((value) => typeof value === 'string' && value.length > 0);
  const configured = identifiersPresent && typeof acquireFn === 'function';
  return {
    name,
    configured,
    async acquire() {
      if (!configured) throw new GraphAuthError('AUTH_NOT_CONFIGURED');
      try {
        const token = await acquireFn();
        if (typeof token !== 'string' || token.length === 0) throw new GraphAuthError('AUTH_FAILED');
        return token;
      } catch (error) {
        if (error instanceof GraphAuthError) throw error;
        throw new GraphAuthError('AUTH_FAILED');
      }
    }
  };
}

// 優先順に最初に構成済みの取得元を使う。取得失敗は次の取得元へ進めない（認証経路の混在を防ぐ）。
function createGraphTokenProvider(sources) {
  const ordered = sources.filter(Boolean);
  const selected = ordered.find((source) => source.configured) || null;
  const provider = async () => {
    if (!selected) throw new GraphAuthError('AUTH_NOT_CONFIGURED');
    return selected.acquire();
  };
  provider.describe = () => ({
    selectedMethod: selected ? selected.name : null,
    methods: ordered.map((source) => ({ name: source.name, configured: source.configured === true }))
  });
  provider.configured = Boolean(selected);
  return provider;
}

module.exports = { createManagedIdentitySource, createInjectedSource, createGraphTokenProvider, GraphAuthError };
