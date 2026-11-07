'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationsMcp } = require('../src/operationsMcp');
const { createGraphClient, GraphClientError } = require('../src/graph/graphClient');
const { createEntraAdapter, classifyGraphError } = require('../src/operations/entraAdapter');
const { createEntraWriter, WRITE_ALLOWED, allowWrite, randomInitialPassword } = require('../src/operations/entraWrite');
const { createPowerPlatformAdapter, PINNED_ENVIRONMENT_ID } = require('../src/operations/powerPlatformAdapter');
const { resolveVisibleCall, FACADES } = require('../src/toolVisibility');
const { PUBLISHED_TOOLS } = require('../src/server');

const TOKEN = 'test-token-value-NOT-A-SECRET-12345';
const provider = Object.assign(async () => TOKEN, { configured: true });
const unconfigured = Object.assign(async () => { throw Object.assign(new Error('x'), { code: 'AUTH_NOT_CONFIGURED' }); }, { configured: false });
const json = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k] ?? null }, json: async () => body });
const noSleep = async () => {};

// ルートに応じて応答を返すモック。呼び出しを記録し、トークンが同一オリジン以外へ送られていないことを確認する。
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, auth: opts.headers.Authorization, body: opts.body ? JSON.parse(opts.body) : undefined });
    for (const [matcher, handler] of routes) {
      const key = `${opts.method} ${url}`;
      if (typeof matcher === 'string' ? key.startsWith(matcher) : matcher.test(key)) {
        const out = typeof handler === 'function' ? handler(url, opts) : handler;
        return out;
      }
    }
    return json({ error: 'no route' }, 404);
  };
  return { fetchImpl, calls };
}

const adapterWith = (fetchImpl, extra = {}) => createEntraAdapter({ tokenProvider: provider, fetchImpl, sleep: noSleep, ...extra });

test('graph client: 401/403/404/5xx/通信失敗/応答不正を種別コードへ分類し、トークンを含めない', async () => {
  const cases = [
    [401, 'AUTH_FAILED'], [403, 'PERMISSION_DENIED'], [404, 'TARGET_NOT_FOUND'], [429, 'RATE_LIMITED'], [503, 'UPSTREAM_ERROR'], [400, 'UPSTREAM_REJECTED']
  ];
  for (const [status, code] of cases) {
    const client = createGraphClient({ tokenProvider: provider, fetchImpl: async () => json({ error: TOKEN }, status), sleep: noSleep, maxRetries: 0 });
    await assert.rejects(client.request({ pathAndQuery: '/x' }), (e) => {
      assert.equal(e.code, code);
      assert.equal(String(e.message).includes(TOKEN), false);
      return true;
    });
  }
  const unreachable = createGraphClient({ tokenProvider: provider, fetchImpl: async () => { throw new Error('ECONNRESET'); }, sleep: noSleep, maxRetries: 0 });
  await assert.rejects(unreachable.request({ pathAndQuery: '/x' }), (e) => e.code === 'UPSTREAM_UNREACHABLE');
  const badJson = createGraphClient({ tokenProvider: provider, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }), sleep: noSleep });
  await assert.rejects(badJson.request({ pathAndQuery: '/x' }), (e) => e.code === 'UPSTREAM_INVALID_RESPONSE');
});

test('graph client: 429 は Retry-After を上限付きで尊重して再試行し、成功すれば返す', async () => {
  let n = 0;
  const waits = [];
  const client = createGraphClient({
    tokenProvider: provider,
    fetchImpl: async () => { n += 1; return n < 3 ? json({}, 429, { 'Retry-After': '1' }) : json({ ok: 1 }); },
    sleep: async (ms) => { waits.push(ms); }, maxRetries: 2
  });
  assert.deepEqual(await client.request({ pathAndQuery: '/x' }), { ok: 1 });
  assert.equal(n, 3);
  assert.deepEqual(waits, [1000, 1000]);
});

test('graph client: 429 が続けば上限回数後に RATE_LIMITED', async () => {
  let n = 0;
  const client = createGraphClient({ tokenProvider: provider, fetchImpl: async () => { n += 1; return json({}, 429); }, sleep: noSleep, maxRetries: 2 });
  await assert.rejects(client.request({ pathAndQuery: '/x' }), (e) => e.code === 'RATE_LIMITED');
  assert.equal(n, 3);
});

test('graph client: ページングは同一オリジンのみ辿り、件数上限で truncated を返す', async () => {
  // 2ページ目のルートを先に置く（前方一致で1ページ目に吸われないように）。
  const { fetchImpl, calls } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/users?page=2', json({ value: [{ id: 3 }] })],
    ['GET https://graph.microsoft.com/v1.0/users', json({ value: [{ id: 1 }, { id: 2 }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?page=2' })]
  ]);
  const client = createGraphClient({ tokenProvider: provider, fetchImpl, sleep: noSleep });
  const all = await client.getAll('/users', { maxItems: 10 });
  assert.equal(all.items.length, 3);
  assert.equal(all.truncated, false);
  const cut = await client.getAll('/users', { maxItems: 2 });
  assert.equal(cut.items.length, 2);
  assert.equal(cut.truncated, true);
  assert.equal(calls.every((c) => c.url.startsWith('https://graph.microsoft.com/')), true);
});

test('graph client: 別オリジンの nextLink は辿らず、トークンも送らない', async () => {
  const { fetchImpl, calls } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/users', json({ value: [{ id: 1 }], '@odata.nextLink': 'https://evil.example.com/steal' })]
  ]);
  const client = createGraphClient({ tokenProvider: provider, fetchImpl, sleep: noSleep });
  await assert.rejects(client.getAll('/users', { maxItems: 10 }), (e) => e.code === 'UPSTREAM_INVALID_RESPONSE');
  assert.equal(calls.some((c) => c.url.includes('evil.example.com')), false);
});

test('graph client: 未構成の取得元は通信しない（AUTH_NOT_CONFIGURED）', async () => {
  let called = false;
  const client = createGraphClient({ tokenProvider: unconfigured, fetchImpl: async () => { called = true; return json({}); }, sleep: noSleep });
  assert.equal(client.configured, false);
  await assert.rejects(client.request({ pathAndQuery: '/x' }), (e) => e.code === 'AUTH_NOT_CONFIGURED');
  assert.equal(called, false);
});

test('Entra READ: テナント・ユーザー検索（引用符エスケープ・上限）・空結果・ライセンスの空き数', async () => {
  const { fetchImpl, calls } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/organization', json({ value: [{ id: 't1', displayName: 'Org', verifiedDomains: [{ name: 'example.jp' }] }] })],
    ['GET https://graph.microsoft.com/v1.0/users', json({ value: [] })],
    ['GET https://graph.microsoft.com/v1.0/subscribedSkus', json({ value: [{ skuId: 's1', skuPartNumber: 'X', consumedUnits: 4, prepaidUnits: { enabled: 10 } }] })]
  ]);
  const a = adapterWith(fetchImpl);
  const tenant = await a.call('entra_tenant_get', {});
  assert.equal(tenant.tenantId, 't1');
  assert.deepEqual(tenant.domains, ['example.jp']);
  const empty = await a.call('entra_user_search', { query: "O'Brien", top: 5 });
  assert.deepEqual(empty.users, []);
  assert.equal(empty.truncated, false);
  assert.ok(calls.some((c) => decodeURIComponent(c.url).includes("O''Brien")));
  const lic = await a.call('entra_licenses_list', {});
  assert.equal(lic.skus[0].available, 6);
});

test('Entra READ: 応答は資格情報を含めず、射影した項目だけを返す', async () => {
  const { fetchImpl } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/applications', json({ value: [{ id: 'a1', appId: 'x', displayName: 'App', passwordCredentials: [{ secretText: 'LEAK' }], keyCredentials: [{ key: 'LEAK' }] }] })]
  ]);
  const r = await adapterWith(fetchImpl).call('entra_apps_list', {});
  assert.equal(JSON.stringify(r).includes('LEAK'), false);
  assert.deepEqual(Object.keys(r.applications[0]).sort(), ['appId', 'displayName', 'id']);
});

test('Entra READ: HTTP 種別（401/403/404/429/5xx）を分類し、権限不足は必要権限を示す', async () => {
  for (const [status, reason] of [[401, 'AUTH_FAILED'], [403, 'PERMISSION_DENIED'], [404, 'TARGET_NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'UPSTREAM_ERROR']]) {
    const { fetchImpl } = mockFetch([['GET https://graph.microsoft.com/v1.0/groups', json({}, status)]]);
    const adapter = adapterWith(fetchImpl, { maxRetries: 0 });
    const mcp = createOperationsMcp({}, { entraAdapter: adapter });
    const r = await mcp.callTool('entra_read_manage', { operation: 'entra_groups_list' });
    assert.equal(r.reasonCode, reason, String(status));
    if (status === 403) assert.deepEqual(r.requiredPermissions, ['Group.Read.All']);
  }
});

test('Entra READ: 未構成は BLOCKED（ADAPTER_NOT_CONFIGURED）、入力は VALIDATION_FAILED', async () => {
  const mcp = createOperationsMcp({}, { entraAdapter: createEntraAdapter({ tokenProvider: unconfigured }) });
  const blocked = await mcp.callTool('entra_read_manage', { operation: 'entra_tenant_get' });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.reasonCode, 'ADAPTER_NOT_CONFIGURED');
  const bad = await mcp.callTool('entra_read_manage', { operation: 'entra_user_search', query: '' });
  assert.equal(bad.reasonCode, 'VALIDATION_FAILED');
  const unknown = await mcp.callTool('entra_read_manage', { operation: 'entra_role_grant' });
  assert.equal(unknown.reasonCode, 'VALIDATION_FAILED');
});

test('Entra WRITE 境界: 許可経路は7操作に限られ、削除・ロール・ライセンス購入の経路は拒否', () => {
  assert.equal(allowWrite('POST', '/users'), true);
  assert.equal(allowWrite('PATCH', '/users/abc'), true);
  assert.equal(allowWrite('POST', '/groups/g1/members/$ref'), true);
  assert.equal(allowWrite('DELETE', '/groups/g1/members/u1/$ref'), true);
  assert.equal(allowWrite('POST', '/users/u1/assignLicense'), true);
  assert.equal(allowWrite('DELETE', '/users/u1'), false, '物理削除');
  assert.equal(allowWrite('DELETE', '/groups/g1'), false, 'グループ削除');
  assert.equal(allowWrite('POST', '/directoryRoles/r1/members/$ref'), false, 'ロール付与');
  assert.equal(allowWrite('POST', '/roleManagement/directory/roleAssignments'), false, 'ロール割当');
  assert.equal(allowWrite('PATCH', '/groups/g1'), false);
  assert.equal(allowWrite('POST', '/subscribedSkus/x/purchase'), false, '購入');
  assert.equal(allowWrite('PUT', '/users/u1'), false);
});

test('Entra WRITE: 既定は dryRun で、事前読取のみ（外部書込みなし）・計画とRollback可否を返す', async () => {
  const { fetchImpl, calls } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/users/u1', json({ id: 'u1', userPrincipalName: 'a@x.jp', accountEnabled: true, usageLocation: 'JP' })]
  ]);
  const writer = createEntraWriter({ adapter: adapterWith(fetchImpl) });
  const r = await writer.run('entra_user_disable', { userId: 'u1' });
  assert.equal(r.status, 'PASS');
  assert.equal(r.executed, false);
  assert.equal(r.rollback.rollbackAvailable, true);
  assert.match(r.snapshot.beforeSha256, /^[a-f0-9]{64}$/);
  assert.equal(calls.some((c) => c.method !== 'GET'), false, '計画のみでは書込みしない');
});

test('Entra WRITE: 実行には approvedByHuman=true が必要', async () => {
  const { fetchImpl, calls } = mockFetch([]);
  const writer = createEntraWriter({ adapter: adapterWith(fetchImpl) });
  const r = await writer.run('entra_user_disable', { userId: 'u1', dryRun: false });
  assert.equal(r.reasonCode, 'APPROVAL_REQUIRED');
  assert.equal(calls.length, 0);
});

test('Entra WRITE: ユーザー作成は無効状態で作り、初期パスワードを応答・計画に出さない', async () => {
  let posted = null;
  const { fetchImpl } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/users?$filter', json({ value: [] })],
    ['POST https://graph.microsoft.com/v1.0/users', (url, opts) => { posted = JSON.parse(opts.body); return json({ id: 'new1' }, 201); }],
    ['GET https://graph.microsoft.com/v1.0/users/new1', json({ id: 'new1', userPrincipalName: 'new@example.jp', accountEnabled: false })]
  ]);
  const writer = createEntraWriter({ adapter: adapterWith(fetchImpl) });
  const r = await writer.run('entra_user_create', { userPrincipalName: 'new@example.jp', displayName: 'New', mailNickname: 'new', dryRun: false, approvedByHuman: true });
  assert.equal(r.status, 'PASS', JSON.stringify(r));
  assert.equal(r.verified, true);
  assert.equal(posted.accountEnabled, false);
  assert.equal(posted.passwordProfile.forceChangePasswordNextSignIn, true);
  const pw = posted.passwordProfile.password;
  assert.equal(JSON.stringify(r).includes(pw), false, '応答に初期パスワードを含めない');
  assert.equal(r.humanActions.length >= 1, true);
  assert.equal(randomInitialPassword().length >= 20, true);
});

test('Entra WRITE: 既存UPNの作成は衝突として停止する', async () => {
  const { fetchImpl, calls } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/users?$filter', json({ value: [{ id: 'x' }] })]
  ]);
  const r = await createEntraWriter({ adapter: adapterWith(fetchImpl) }).run('entra_user_create', { userPrincipalName: 'a@example.jp', displayName: 'A', mailNickname: 'a', dryRun: false, approvedByHuman: true });
  assert.equal(r.reasonCode, 'USER_ALREADY_EXISTS');
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('Entra WRITE: ライセンス割当は空きが無ければ購入せず停止する', async () => {
  const { fetchImpl, calls } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/users/u1', json({ id: 'u1', usageLocation: 'JP', assignedLicenses: [] })],
    ['GET https://graph.microsoft.com/v1.0/subscribedSkus', json({ value: [{ skuId: '11111111-1111-1111-1111-111111111111', consumedUnits: 10, prepaidUnits: { enabled: 10 } }] })]
  ]);
  const r = await createEntraWriter({ adapter: adapterWith(fetchImpl) }).run('entra_license_assign', { userId: 'u1', skuId: '11111111-1111-1111-1111-111111111111', dryRun: false, approvedByHuman: true });
  assert.equal(r.reasonCode, 'LICENSE_UNITS_UNAVAILABLE');
  assert.equal(calls.some((c) => c.url.includes('assignLicense')), false);
});

test('Entra WRITE: 利用国が無いユーザーへのライセンス割当は停止する', async () => {
  const { fetchImpl } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/users/u1', json({ id: 'u1', assignedLicenses: [] })]
  ]);
  const r = await createEntraWriter({ adapter: adapterWith(fetchImpl) }).run('entra_license_assign', { userId: 'u1', skuId: '11111111-1111-1111-1111-111111111111' });
  assert.equal(r.reasonCode, 'USAGE_LOCATION_REQUIRED');
});

test('Entra WRITE: グループ追加は $ref で行い、再取得で確認する（追加されなければ VERIFY_MISMATCH）', async () => {
  const u1 = '22222222-2222-2222-2222-222222222222';
  const g1 = '33333333-3333-3333-3333-333333333333';
  const members = { current: [] };
  const { fetchImpl, calls } = mockFetch([
    [`GET https://graph.microsoft.com/v1.0/groups/${g1}/members`, () => json({ value: members.current.map((id) => ({ id })) })],
    [`GET https://graph.microsoft.com/v1.0/groups/${g1}`, json({ id: g1 })],
    [`GET https://graph.microsoft.com/v1.0/users/${u1}`, json({ id: u1 })],
    [`POST https://graph.microsoft.com/v1.0/groups/${g1}/members/$ref`, () => json({}, 204)]
  ]);
  const writer = createEntraWriter({ adapter: adapterWith(fetchImpl) });
  const ok = await writer.run('entra_group_member_add', { groupId: g1, userId: u1, dryRun: false, approvedByHuman: true });
  assert.equal(ok.reasonCode, 'VERIFY_MISMATCH', 'モックは追加を反映しないため検証で不一致になる');
  assert.equal(ok.executed, true);
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('$ref'));
  assert.equal(post.body['@odata.id'].endsWith(`/directoryObjects/${u1}`), true);
});

test('Entra WRITE: 既に目的の状態なら変更せず noChange', async () => {
  const { fetchImpl, calls } = mockFetch([
    ['GET https://graph.microsoft.com/v1.0/users/u1', json({ id: 'u1', accountEnabled: false, userPrincipalName: 'a@x.jp' })]
  ]);
  const r = await createEntraWriter({ adapter: adapterWith(fetchImpl) }).run('entra_user_disable', { userId: 'u1', dryRun: false, approvedByHuman: true });
  assert.equal(r.noChange, true);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
});

test('Entra WRITE: 物理削除・ロール付与・購入の操作名は入力検証で拒否', async () => {
  const writer = createEntraWriter({ adapter: adapterWith(mockFetch([]).fetchImpl) });
  for (const op of ['entra_user_delete', 'entra_role_grant', 'entra_license_purchase']) {
    const r = await writer.run(op, { userId: 'u1' });
    assert.equal(r.reasonCode, 'VALIDATION_FAILED', op);
  }
  const extra = await writer.run('entra_user_update', { userId: 'u1', changes: { displayName: 'x', password: 'y' } });
  assert.equal(extra.reasonCode, 'VALIDATION_FAILED');
});

test('Entra WRITE: 未構成は BLOCKED で書込みを行わない', async () => {
  const writer = createEntraWriter({ adapter: createEntraAdapter({ tokenProvider: unconfigured }) });
  const r = await writer.run('entra_user_disable', { userId: 'u1', dryRun: false, approvedByHuman: true });
  assert.equal(r.status, 'BLOCKED');
});

// ---- Power Platform READ ----

const PP = 'https://api.bap.microsoft.com';
const INSTANCE = 'https://org123.crm.dynamics.com';

function ppRoutes(overrides = {}) {
  return [
    [`GET ${PP}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${PINNED_ENVIRONMENT_ID}?`, json({ location: 'japan', properties: { displayName: 'CN', linkedEnvironmentMetadata: overrides.noDataverse ? null : { instanceUrl: INSTANCE } } })],
    [`GET ${PP}/providers/Microsoft.PowerApps/scopes/admin/environments/${PINNED_ENVIRONMENT_ID}/connections?`, json({ value: [{ name: 'c1', properties: { displayName: 'SP', apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', statuses: [{ status: 'Connected' }], connectionParameters: { token: { value: 'LEAK-PARAM' } } } }] })],
    [`GET ${PP}/providers/Microsoft.PowerApps/scopes/admin/environments/${PINNED_ENVIRONMENT_ID}/connections/c1?`, json({ properties: { apiId: '/providers/Microsoft.PowerApps/apis/shared_x', statuses: [{ status: 'Error' }] } })],
    [`GET ${INSTANCE}/api/data/v9.2/environmentvariabledefinitions`, json({ value: [{ schemaname: 'cn_url', displayname: 'URL', type: 100000000, environmentvariabledefinitionid: 'd1' }] })],
    [`GET ${INSTANCE}/api/data/v9.2/environmentvariablevalues`, json({ value: [{ _environmentvariabledefinitionid_value: 'd1', value: 'SECRET-VALUE-LEAK' }] })],
    [`GET ${INSTANCE}/api/data/v9.2/solutions`, json({ value: [{ uniquename: 'CNSol', friendlyname: 'CN', version: '1.0', ismanaged: false }] })],
    [`GET ${PP}/providers/Microsoft.BusinessAppPlatform/scopes/admin/policies`, json({ value: [{ name: 'p1', properties: { displayName: 'DLP', connectorGroups: { Blocked: [{}], General: [{}, {}] } } }] })]
  ];
}

test('Power Platform READ: 未構成は BLOCKED、環境IDを指定する入力は拒否（対象は固定）', async () => {
  const mcp = createOperationsMcp({}, { powerPlatformAdapter: createPowerPlatformAdapter({ tokenFor: () => unconfigured }) });
  const blocked = await mcp.callTool('power_platform_manage', { operation: 'pp_environment_get' });
  assert.equal(blocked.status, 'BLOCKED');
  const withEnv = await mcp.callTool('power_platform_manage', { operation: 'pp_environment_get', environmentId: 'other' });
  assert.equal(withEnv.reasonCode, 'VALIDATION_FAILED');
  const unknown = await mcp.callTool('power_platform_manage', { operation: 'pp_environment_delete' });
  assert.equal(unknown.reasonCode, 'VALIDATION_FAILED');
});

test('Power Platform READ: 接続は認証パラメータを返さず、環境変数は値を返さない', async () => {
  const { fetchImpl } = mockFetch(ppRoutes());
  const adapter = createPowerPlatformAdapter({ tokenFor: () => provider, fetchImpl, sleep: noSleep });
  const mcp = createOperationsMcp({}, { powerPlatformAdapter: adapter });
  const conns = await mcp.callTool('power_platform_manage', { operation: 'pp_connections_list' });
  assert.equal(conns.status, 'PASS');
  assert.equal(JSON.stringify(conns).includes('LEAK-PARAM'), false);
  assert.equal(conns.connections[0].status, 'Connected');
  const vars = await mcp.callTool('power_platform_manage', { operation: 'environment_variables_get' });
  assert.equal(vars.status, 'PASS');
  assert.equal(JSON.stringify(vars).includes('SECRET-VALUE-LEAK'), false);
  assert.equal(vars.variables[0].hasCurrentValue, true);
  assert.equal(vars.variables[0].schemaName, 'cn_url');
});

test('Power Platform READ: 対象環境は固定、Dataverse 未プロビジョニングは FAIL（作成しない）', async () => {
  const { fetchImpl, calls } = mockFetch(ppRoutes({ noDataverse: true }));
  const mcp = createOperationsMcp({}, { powerPlatformAdapter: createPowerPlatformAdapter({ tokenFor: () => provider, fetchImpl, sleep: noSleep }) });
  const env = await mcp.callTool('power_platform_manage', { operation: 'pp_environment_get' });
  assert.equal(env.environmentId, PINNED_ENVIRONMENT_ID);
  assert.equal(env.dataverseProvisioned, false);
  const sol = await mcp.callTool('power_platform_manage', { operation: 'solutions_list' });
  assert.equal(sol.dataverseError, 'DATAVERSE_NOT_PROVISIONED');
  assert.equal(calls.every((c) => c.method === 'GET'), true, '読取のみ');
});

test('Power Platform READ: connection_test は状態のみ、DLP は読取のみ', async () => {
  const { fetchImpl } = mockFetch(ppRoutes());
  const mcp = createOperationsMcp({}, { powerPlatformAdapter: createPowerPlatformAdapter({ tokenFor: () => provider, fetchImpl, sleep: noSleep }) });
  const t = await mcp.callTool('power_platform_manage', { operation: 'pp_connection_test', connectionName: 'c1' });
  assert.equal(t.connected, false);
  assert.equal(t.status !== undefined, true);
  const dlp = await mcp.callTool('power_platform_manage', { operation: 'pp_dlp_policies_list' });
  assert.equal(dlp.policies[0].connectorGroupCounts.general, 2);
  const badName = await mcp.callTool('power_platform_manage', { operation: 'pp_connection_test', connectionName: '../x' });
  assert.equal(badName.reasonCode, 'VALIDATION_FAILED');
});

// ---- 公開面 ----

test('公開面: entra_read / entra_write / power_platform_read が追加され、内部ツールは非公開、件数は 70 未満', () => {
  const names = PUBLISHED_TOOLS.map((t) => t.name);
  for (const n of ['entra_read', 'entra_write', 'power_platform_read']) assert.ok(names.includes(n), n);
  for (const n of ['entra_read_manage', 'entra_write_manage', 'power_platform_manage']) assert.equal(names.includes(n), false, n);
  assert.ok(PUBLISHED_TOOLS.length < 70, String(PUBLISHED_TOOLS.length));
});

test('facade: 未知の action は VALIDATION_FAILED で拒否し、正しい action は内部ツールへ解決される', () => {
  assert.throws(() => resolveVisibleCall('entra_write', { operation: 'entra_user_delete' }), (e) => e.payload.reasonCode === 'VALIDATION_FAILED');
  assert.throws(() => resolveVisibleCall('power_platform_read', { operation: 'pp_environment_create' }), (e) => e.payload.reasonCode === 'VALIDATION_FAILED');
  const r = resolveVisibleCall('entra_write', { operation: 'entra_group_member_add', groupId: 'g', userId: 'u' });
  assert.equal(r.name, 'entra_write_manage');
  assert.equal(r.args.operation, 'entra_group_member_add');
  for (const name of ['entra_read', 'entra_write', 'power_platform_read']) {
    const f = FACADES.find((x) => x.name === name);
    assert.equal(f.errorCode, 'VALIDATION_FAILED');
  }
});

test('classifyGraphError: 値を含まない・権限不足は必要権限を返す', () => {
  const r = classifyGraphError(new GraphClientError('PERMISSION_DENIED', 403), 'entra_audit_logs_get');
  assert.deepEqual(r.requiredPermissions, ['AuditLog.Read.All']);
  assert.equal(JSON.stringify(r).includes(TOKEN), false);
});
