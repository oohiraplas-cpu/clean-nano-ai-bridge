'use strict';

// Microsoft Graph 共通クライアント（SharePoint / Entra ID で共有）。
// - 認証: tokenProvider（graphAuth.js）から都度取得。トークン・応答本文・URLの秘密部分はエラーに含めない。
// - HTTP: タイムアウト、429 の再試行（Retry-After を上限付きで尊重）、5xx の GET 再試行。
// - 分類: 401 AUTH_FAILED / 403 PERMISSION_DENIED / 404 TARGET_NOT_FOUND / 429 RATE_LIMITED /
//         5xx UPSTREAM_ERROR / 通信失敗 UPSTREAM_UNREACHABLE / 応答不正 UPSTREAM_INVALID_RESPONSE。
// - ページング: @odata.nextLink は Graph の同一オリジンだけを辿る（別ホストへトークンを送らない）。件数上限を必ず適用する。
// - 書込みは呼出元の許可関数（allowWrite）を通したものだけ送る。

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 3000;
const CODE_RE = /^AUTH_[A-Z_]+$/;

class GraphClientError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'GraphClientError';
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

function createGraphClient({
  tokenProvider = null,
  fetchImpl = globalThis.fetch,
  graphBase = GRAPH_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = 2,
  retryBaseMs = 300,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const configured = typeof tokenProvider === 'function' && tokenProvider.configured !== false;
  const base = new URL(graphBase);

  async function acquireToken() {
    let token;
    try {
      token = await tokenProvider();
    } catch (error) {
      const code = typeof error?.code === 'string' && CODE_RE.test(error.code) ? error.code : 'AUTH_FAILED';
      throw new GraphClientError(code);
    }
    if (typeof token !== 'string' || token.length === 0) throw new GraphClientError('AUTH_FAILED');
    return token;
  }

  function retryDelay(response, attempt) {
    const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('Retry-After') : null;
    const seconds = Number(header);
    const fromHeader = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
    const base2 = fromHeader ?? retryBaseMs * (2 ** attempt);
    return Math.min(base2, MAX_RETRY_AFTER_MS);
  }

  // 1回の要求。応答の JSON を返す（本文が無ければ {}）。
  async function request({ method = 'GET', pathAndQuery, body, allowWrite = null, absoluteUrl = null }) {
    if (!configured) throw new GraphClientError('AUTH_NOT_CONFIGURED');
    if (method !== 'GET' && (!allowWrite || !allowWrite(method, pathAndQuery))) throw new GraphClientError('WRITE_PATH_REJECTED');
    const url = absoluteUrl || `${graphBase}${pathAndQuery}`;
    for (let attempt = 0; ; attempt += 1) {
      const token = await acquireToken();
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch {
        if (method === 'GET' && attempt < maxRetries) { await sleep(retryDelay({}, attempt)); continue; }
        throw new GraphClientError('UPSTREAM_UNREACHABLE');
      }
      if (response.ok) {
        if (method === 'DELETE' || response.status === 204) return {};
        try {
          return await response.json();
        } catch {
          if (method === 'GET') throw new GraphClientError('UPSTREAM_INVALID_RESPONSE');
          return {};
        }
      }
      const retryable = response.status === 429 || (method === 'GET' && response.status >= 500);
      if (retryable && attempt < maxRetries) { await sleep(retryDelay(response, attempt)); continue; }
      throw new GraphClientError(mapHttpStatus(response.status), response.status);
    }
  }

  // 同一オリジンの nextLink だけを許可する。
  function sameGraphOrigin(link) {
    try {
      const u = new URL(link);
      return u.protocol === 'https:' && u.origin === base.origin;
    } catch {
      return false;
    }
  }

  // 件数上限付きのページング。maxItems に達したら truncated=true で返す。
  async function getAll(pathAndQuery, { maxItems = 200, maxPages = 10 } = {}) {
    const items = [];
    let next = null;
    let pages = 0;
    let truncated = false;
    let data = await request({ pathAndQuery });
    for (;;) {
      pages += 1;
      for (const item of Array.isArray(data.value) ? data.value : []) {
        if (items.length >= maxItems) { truncated = true; break; }
        items.push(item);
      }
      next = typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : null;
      if (truncated || !next) break;
      if (pages >= maxPages) { truncated = true; break; }
      if (!sameGraphOrigin(next)) throw new GraphClientError('UPSTREAM_INVALID_RESPONSE');
      data = await request({ pathAndQuery: null, absoluteUrl: next });
    }
    return { items, truncated, pages };
  }

  return { configured, graphBase, request, getAll, sameGraphOrigin };
}

module.exports = { createGraphClient, GraphClientError, mapHttpStatus, GRAPH_BASE };
