'use strict';
// Lane B: Graph トークン取得境界（Managed Identity → 証明書 → 委任）と SharePoint 共通診断のモック試験。
// 実資格情報・実通信は行わない。BLOCKED は実環境未確認として扱う。
const assert = require('node:assert/strict');
const test = require('node:test');
const { createManagedIdentitySource, createInjectedSource, createGraphTokenProvider, GraphAuthError } = require('../src/operations/graphAuth');
const { createSharePointGraphAdapter } = require('../src/operations/sharePointGraphAdapter');
const { runSharePointDiagnostics } = require('../src/operations/sharePointDiagnostics');
const { createOperationsMcp } = require('../src/operationsMcp');

const SECRET_HEADER = 'identity-header-secret-QQQQ7001';
const TOKEN = 'eyJ-test-access-token-RRRR7002';
const SITE_URL = 'https://hisyoengineer.sharepoint.com/sites/cleannano';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Graph と Managed Identity の両方を模したフェイク fetch。
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [pattern, handler] of routes) {
      if (String(url).includes(pattern)) return handler(url, opts);
    }
    return jsonResponse(404, {});
  };
  fn.calls = calls;
  return fn;
}

const graphOk = () => [
  ['/sites/hisyoengineer.sharepoint.com:/sites/cleannano', () => jsonResponse(200, { id: 'site-id-1', displayName: 'cleannano' })],
  ['/permissions', () => jsonResponse(200, { value: [{ id: 'p1', roles: ['read'], grantedToIdentitiesV2: [] }] })]
];

// ---------- Managed Identity ----------

test('managed identity is unconfigured without both endpoint and header, and makes no request', async () => {
  const fetchImpl = fakeFetch([]);
  const source = createManagedIdentitySource({ identityEndpoint: 'https://id.example/msi', identityHeader: '', fetchImpl });
  assert.equal(source.configured, false);
  await assert.rejects(source.acquire(), (e) => e.code === 'AUTH_NOT_CONFIGURED');
  assert.equal(fetchImpl.calls.length, 0);
});

test('managed identity sends the header and resource, returns the token, and caches it until near expiry', async () => {
  let now = 1_000_000;
  const fetchImpl = fakeFetch([['/msi', () => jsonResponse(200, { access_token: TOKEN, expires_on: String(Math.floor(now / 1000) + 3600) })]]);
  const source = createManagedIdentitySource({ identityEndpoint: 'https://id.example/msi', identityHeader: SECRET_HEADER, fetchImpl, now: () => now });
  assert.equal(await source.acquire(), TOKEN);
  assert.equal(await source.acquire(), TOKEN);
  assert.equal(fetchImpl.calls.length, 1, 'second call is served from cache');
  const first = fetchImpl.calls[0];
  assert.match(first.url, /resource=https%3A%2F%2Fgraph\.microsoft\.com/);
  assert.equal(first.opts.headers['X-IDENTITY-HEADER'], SECRET_HEADER);
  now += 3600 * 1000; // 失効後は再取得する
  await source.acquire();
  assert.equal(fetchImpl.calls.length, 2);
});

test('managed identity failures map to AUTH codes and never echo the body or header', async () => {
  for (const handler of [() => jsonResponse(401, { error: 'bad ' + SECRET_HEADER }), () => { throw new Error('ECONNRESET ' + SECRET_HEADER); }]) {
    const source = createManagedIdentitySource({ identityEndpoint: 'https://id.example/msi', identityHeader: SECRET_HEADER, fetchImpl: fakeFetch([['/msi', handler]]) });
    await assert.rejects(source.acquire(), (e) => {
      assert.ok(['AUTH_FAILED', 'AUTH_UNREACHABLE'].includes(e.code));
      assert.equal(String(e.message).includes(SECRET_HEADER), false);
      return true;
    });
  }
});

test('managed identity rejects a response without an access token', async () => {
  const source = createManagedIdentitySource({ identityEndpoint: 'https://id.example/msi', identityHeader: SECRET_HEADER, fetchImpl: fakeFetch([['/msi', () => jsonResponse(200, {})]]) });
  await assert.rejects(source.acquire(), (e) => e.code === 'AUTH_FAILED');
});

// ---------- 取得元の優先順 ----------

test('provider prefers managed identity, then certificate, then delegated, and reports only names', async () => {
  const msi = createManagedIdentitySource({ identityEndpoint: 'https://id.example/msi', identityHeader: SECRET_HEADER, fetchImpl: fakeFetch([['/msi', () => jsonResponse(200, { access_token: TOKEN })]]) });
  const cert = createInjectedSource({ name: 'certificate', identifiers: { tenantId: 't', clientId: 'c', thumbprint: 'x' }, acquireFn: async () => 'cert-token' });
  const delegated = createInjectedSource({ name: 'delegated', identifiers: { tenantId: 't', clientId: 'c' }, acquireFn: async () => 'del-token' });
  const provider = createGraphTokenProvider([msi, cert, delegated]);
  assert.equal(await provider(), TOKEN);
  assert.equal(provider.describe().selectedMethod, 'managedIdentity');
  assert.equal(JSON.stringify(provider.describe()).includes(SECRET_HEADER), false);

  const noMsi = createGraphTokenProvider([
    createManagedIdentitySource({}),
    cert,
    delegated
  ]);
  assert.equal(await noMsi(), 'cert-token');
  assert.equal(noMsi.describe().selectedMethod, 'certificate');

  const onlyDelegated = createGraphTokenProvider([createManagedIdentitySource({}), createInjectedSource({ name: 'certificate', identifiers: {} }), delegated]);
  assert.equal(await onlyDelegated(), 'del-token');
});

test('provider with no configured source reports AUTH_NOT_CONFIGURED (BLOCKED) and never calls out', async () => {
  const provider = createGraphTokenProvider([createManagedIdentitySource({}), createInjectedSource({ name: 'certificate', identifiers: { tenantId: 't' } })]);
  assert.equal(provider.configured, false);
  await assert.rejects(provider(), (e) => e instanceof GraphAuthError && e.code === 'AUTH_NOT_CONFIGURED');
});

test('an injected certificate source that fails does not fall through to another source', async () => {
  const cert = createInjectedSource({ name: 'certificate', identifiers: { tenantId: 't', clientId: 'c', thumbprint: 'x' }, acquireFn: async () => { throw new Error('signing failed ' + SECRET_HEADER); } });
  const delegated = createInjectedSource({ name: 'delegated', identifiers: { tenantId: 't', clientId: 'c' }, acquireFn: async () => 'del-token' });
  const provider = createGraphTokenProvider([cert, delegated]);
  await assert.rejects(provider(), (e) => e.code === 'AUTH_FAILED' && !String(e.message).includes(SECRET_HEADER));
});

test('injected source with an empty token is treated as AUTH_FAILED', async () => {
  const source = createInjectedSource({ name: 'delegated', identifiers: { tenantId: 't', clientId: 'c' }, acquireFn: async () => '' });
  await assert.rejects(source.acquire(), (e) => e.code === 'AUTH_FAILED');
});

// ---------- SharePoint 共通診断 ----------

function adapterWith(provider, fetchImpl) {
  return createSharePointGraphAdapter({ siteUrl: SITE_URL, tokenProvider: provider, fetchImpl });
}
const providerOk = async () => TOKEN;

test('diagnostics are BLOCKED when the adapter has no configured token provider, without any request', async () => {
  const fetchImpl = fakeFetch(graphOk());
  const adapter = adapterWith(createGraphTokenProvider([createManagedIdentitySource({})]), fetchImpl);
  const diagnosis = await runSharePointDiagnostics(adapter);
  assert.equal(diagnosis.status, 'BLOCKED');
  assert.equal(diagnosis.checks[0].reasonCode, 'AUTH_NOT_CONFIGURED');
  assert.equal(fetchImpl.calls.length, 0);
});

test('diagnostics PASS when site and permissions are readable, and expose no site id or token', async () => {
  const fetchImpl = fakeFetch(graphOk());
  const diagnosis = await runSharePointDiagnostics(adapterWith(providerOk, fetchImpl));
  assert.equal(diagnosis.status, 'PASS');
  assert.equal(diagnosis.siteReadable, true);
  assert.equal(diagnosis.permissionsReadable, true);
  const text = JSON.stringify(diagnosis);
  assert.equal(text.includes('site-id-1') || text.includes(TOKEN), false);
  assert.equal(fetchImpl.calls.every((c) => c.opts.method === 'GET'), true, 'diagnostics are READ-only');
});

test('diagnostics map each upstream failure to its own code and skip the permission step', async () => {
  const cases = [
    [401, 'AUTH_FAILED'], [403, 'PERMISSION_DENIED'], [404, 'TARGET_NOT_FOUND'], [429, 'RATE_LIMITED'], [503, 'UPSTREAM_ERROR']
  ];
  for (const [status, code] of cases) {
    const fetchImpl = fakeFetch([['/sites/hisyoengineer', () => jsonResponse(status, {})]]);
    const diagnosis = await runSharePointDiagnostics(adapterWith(providerOk, fetchImpl));
    assert.equal(diagnosis.status, 'FAIL', `status ${status}`);
    assert.equal(diagnosis.checks[0].reasonCode, code);
    assert.equal(diagnosis.checks[1].result, 'SKIPPED');
    assert.equal(diagnosis.siteReachable, false);
  }
});

test('diagnostics FAIL the permission step separately when the site is readable but permissions are denied', async () => {
  const fetchImpl = fakeFetch([
    ['/sites/hisyoengineer', () => jsonResponse(200, { id: 'site-id-1' })],
    ['/permissions', () => jsonResponse(403, {})]
  ]);
  const diagnosis = await runSharePointDiagnostics(adapterWith(providerOk, fetchImpl));
  assert.equal(diagnosis.status, 'FAIL');
  assert.equal(diagnosis.siteReadable, true);
  assert.equal(diagnosis.checks[1].reasonCode, 'PERMISSION_DENIED');
});

// ---------- permission_check / connection_test が同じ診断を使う ----------

test('permission_check and connection_test share the diagnosis: PASS when the site is readable', async () => {
  const fetchImpl = fakeFetch(graphOk());
  const config = { graphAuth: { identityEndpoint: 'https://id.example/msi', identityHeader: SECRET_HEADER } };
  const mcp = createOperationsMcp(config, { fetchImpl: async (url, opts) => {
    if (String(url).startsWith('https://id.example/msi')) return jsonResponse(200, { access_token: TOKEN });
    return fetchImpl(url, opts);
  } });
  const perm = await mcp.callTool('permission_check', { scope: 'sharepoint', requiredPermissions: ['Sites.Selected'] });
  assert.equal(perm.status, 'PASS');
  const conn = await mcp.callTool('connection_test', { target: 'sharepoint' });
  assert.equal(conn.status, 'PASS');
  assert.equal(conn.reachable, true);
  const other = await mcp.callTool('connection_test', { target: 'github' });
  assert.equal(other.reasonCode, 'UNSUPPORTED_TARGET');
  assert.equal(JSON.stringify([perm, conn, other]).includes(TOKEN), false);
});

test('permission_check is BLOCKED (not PASS) when no Graph credential source is configured', async () => {
  const mcp = createOperationsMcp({ graphAuth: {} });
  const perm = await mcp.callTool('permission_check', { scope: 'sharepoint', requiredPermissions: ['Sites.Selected'] });
  assert.equal(perm.status, 'BLOCKED');
  const conn = await mcp.callTool('connection_test', { target: 'sharepoint' });
  assert.equal(conn.status, 'BLOCKED');
});

test('permission_check does not grant Sites.Selected for a non-SharePoint scope even when SharePoint reads succeed', async () => {
  const fetchImpl = fakeFetch(graphOk());
  const mcp = createOperationsMcp({ graphAuth: { identityEndpoint: 'https://id.example/msi', identityHeader: SECRET_HEADER } }, { fetchImpl: async (url, opts) => {
    if (String(url).startsWith('https://id.example/msi')) return jsonResponse(200, { access_token: TOKEN });
    return fetchImpl(url, opts);
  } });
  const perm = await mcp.callTool('permission_check', { scope: 'entra', requiredPermissions: ['Sites.Selected'] });
  assert.equal(perm.status, 'FAIL');
  assert.equal(perm.reasonCode, 'PERMISSION_MISSING');
});
