'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createSharePointGraphAdapter, parseSiteUrl, SharePointAdapterError, mapHttpStatus } = require('../src/operations/sharePointGraphAdapter');
const { createOperationsMcp } = require('../src/operationsMcp');

const SITE_URL = 'https://hisyoengineer.sharepoint.com/sites/cleannano';
const SITE_ID = 'contoso.sharepoint.com,site-guid,web-guid';
const LIST_ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'TOKEN-SECRET-XYZ-987654';

// Graph を模したモック。呼び出しURLとヘッダーを記録し、経路ごとの応答を返す。
function graphMock(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, method: options.method });
    const path = url.replace('https://graph.microsoft.com/v1.0', '');
    const route = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    const [, handler] = route;
    if (typeof handler === 'number') return { ok: false, status: handler, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => handler(path) };
  };
  return { calls, fetchImpl };
}

const defaultRoutes = {
  [`/sites/hisyoengineer.sharepoint.com:/sites/cleannano`]: () => ({ id: SITE_ID, displayName: 'Clean Nano', webUrl: SITE_URL }),
  [`/sites/${encodeURIComponent(SITE_ID)}/lists?`]: () => ({ value: [{ id: LIST_ID, displayName: '社員台帳', name: 'CN_EmployeeLedger', hidden: false }] }),
  [`/sites/${encodeURIComponent(SITE_ID)}/lists/${LIST_ID}?`]: () => ({ id: LIST_ID, displayName: '社員台帳', name: 'CN_EmployeeLedger', list: { template: 'genericList' } }),
  [`/sites/${encodeURIComponent(SITE_ID)}/lists/${LIST_ID}/columns`]: () => ({ value: [{ id: 'c1', name: 'EmployeeId', displayName: '社員ID', required: true, readOnly: false, hidden: false }] }),
  [`/sites/${encodeURIComponent(SITE_ID)}/lists/${LIST_ID}/items/7`]: () => ({ id: '7', fields: { Title: 'A', EmployeeId: 'E-7' } }),
  [`/sites/${encodeURIComponent(SITE_ID)}/lists/${LIST_ID}/items?`]: () => ({ value: [
    { id: '1', fields: { Title: 'A', Status: '在籍', Secret: 'x' } },
    { id: '2', fields: { Title: 'B', Status: '退職' } },
    { id: '3', fields: { Title: 'C', Status: '在籍' } }
  ] }),
  [`/sites/${encodeURIComponent(SITE_ID)}/permissions`]: () => ({ value: [{ id: 'p1', roles: ['read'], grantedToIdentitiesV2: [{}] }] })
};

function adapterWith(routes, tokenProvider = async () => TOKEN) {
  const mock = graphMock(routes);
  const adapter = createSharePointGraphAdapter({ siteUrl: SITE_URL, tokenProvider, fetchImpl: mock.fetchImpl });
  return { adapter, calls: mock.calls };
}

test('the adapter is pinned to the cleannano site and rejects other hosts or schemes', () => {
  assert.deepEqual(parseSiteUrl(SITE_URL), { hostname: 'hisyoengineer.sharepoint.com', sitePath: '/sites/cleannano' });
  assert.throws(() => parseSiteUrl('http://hisyoengineer.sharepoint.com/sites/cleannano'), /https/);
  assert.throws(() => parseSiteUrl('https://example.com/sites/cleannano'), /SharePoint Online/);
  assert.throws(() => parseSiteUrl('https://hisyoengineer.sharepoint.com/teams/x'), /\/sites/);
});

test('without a token provider the adapter is not configured and makes no network call', async () => {
  const mock = graphMock(defaultRoutes);
  const adapter = createSharePointGraphAdapter({ siteUrl: SITE_URL, fetchImpl: mock.fetchImpl });
  assert.equal(adapter.configured, false);
  await assert.rejects(() => adapter.siteGet(), (error) => error.code === 'AUTH_NOT_CONFIGURED');
  assert.equal(mock.calls.length, 0);
});

test('sp_site_get calls the site-by-path endpoint with a bearer token', async () => {
  const { adapter, calls } = adapterWith(defaultRoutes);
  const site = await adapter.siteGet();
  assert.equal(site.siteId, SITE_ID);
  assert.equal(calls[0].url, 'https://graph.microsoft.com/v1.0/sites/hisyoengineer.sharepoint.com:/sites/cleannano?$select=id,displayName,webUrl');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].method, 'GET');
});

test('list endpoints resolve the site id once and then reuse it', async () => {
  const { adapter, calls } = adapterWith(defaultRoutes);
  const lists = await adapter.listsList({ top: 10 });
  await adapter.listSchemaGet({ listId: LIST_ID });
  assert.equal(lists[0].listId, LIST_ID);
  assert.equal(calls.filter((c) => c.url.includes('/sites/hisyoengineer.sharepoint.com:')).length, 1);
  assert.match(calls[1].url, /\/lists\?\$select=id,displayName,name,hidden&\$top=10$/);
});

test('the schema endpoint returns internal names and required flags', async () => {
  const { adapter } = adapterWith(defaultRoutes);
  const columns = await adapter.listSchemaGet({ listId: LIST_ID });
  assert.deepEqual(columns[0], {
    columnId: 'c1', internalName: 'EmployeeId', displayName: '社員ID', hidden: false, readOnly: false, required: true, columnGroup: null
  });
});

test('item get and query use expanded fields and the requested page size', async () => {
  const { adapter, calls } = adapterWith(defaultRoutes);
  const item = await adapter.itemGet({ listId: LIST_ID, itemId: '7' });
  assert.equal(item.fields.EmployeeId, 'E-7');
  const items = await adapter.itemQuery({ listId: LIST_ID, top: 3 });
  assert.equal(items.length, 3);
  assert.ok(calls.some((c) => c.url.endsWith(`/lists/${LIST_ID}/items?$expand=fields&$top=3`)));
});

test('permissions are returned as roles and grant kinds without identifiers of grantees', async () => {
  const { adapter } = adapterWith(defaultRoutes);
  const permissions = await adapter.permissionsGet();
  assert.deepEqual(permissions, [{ permissionId: 'p1', roles: ['read'], grantedToKinds: 'identities' }]);
});

test('HTTP failures map to stable codes without exposing the response body or token', async () => {
  assert.equal(mapHttpStatus(401), 'AUTH_FAILED');
  assert.equal(mapHttpStatus(403), 'PERMISSION_DENIED');
  assert.equal(mapHttpStatus(404), 'TARGET_NOT_FOUND');
  assert.equal(mapHttpStatus(429), 'RATE_LIMITED');
  assert.equal(mapHttpStatus(503), 'UPSTREAM_ERROR');
  const { adapter } = adapterWith({ [`/sites/hisyoengineer.sharepoint.com:/sites/cleannano`]: 403 });
  await assert.rejects(() => adapter.siteGet(), (error) => error instanceof SharePointAdapterError && error.code === 'PERMISSION_DENIED' && error.status === 403);
});

test('a rejected token provider is reported as AUTH_FAILED and never sent to the network', async () => {
  const mock = graphMock(defaultRoutes);
  const adapter = createSharePointGraphAdapter({ siteUrl: SITE_URL, tokenProvider: async () => { throw new Error('boom'); }, fetchImpl: mock.fetchImpl });
  await assert.rejects(() => adapter.siteGet(), (error) => error.code === 'AUTH_FAILED');
  assert.equal(mock.calls.length, 0);
});

test('a network failure is reported as UPSTREAM_UNREACHABLE', async () => {
  const adapter = createSharePointGraphAdapter({
    siteUrl: SITE_URL, tokenProvider: async () => TOKEN, fetchImpl: async () => { throw new Error('ECONNRESET'); }
  });
  await assert.rejects(() => adapter.siteGet(), (error) => error.code === 'UPSTREAM_UNREACHABLE');
});

test('the adapter exposes no write operations', () => {
  const adapter = createSharePointGraphAdapter({ siteUrl: SITE_URL, tokenProvider: async () => TOKEN, fetchImpl: async () => ({}) });
  const writeLike = Object.keys(adapter).filter((name) => /create|update|delete|post|patch|put|set|add|remove/i.test(name));
  assert.deepEqual(writeLike, []);
});

// ---- ツール層（モック経由） ----

function runtimeWith(routes, tokenProvider = async () => TOKEN) {
  const { adapter, calls } = adapterWith(routes, tokenProvider);
  return { mcp: createOperationsMcp({}, { adapters: { sharePoint: adapter } }), calls };
}

test('the sp_* read tools return data from the mocked site', async () => {
  const { mcp } = runtimeWith(defaultRoutes);
  assert.equal((await mcp.callTool('sp_site_get')).site.siteId, SITE_ID);
  assert.equal((await mcp.callTool('sp_lists_list', { top: 5 })).count, 1);
  assert.equal((await mcp.callTool('sp_list_get', { listId: LIST_ID })).list.listId, LIST_ID);
  assert.equal((await mcp.callTool('sp_list_schema_get', { listId: LIST_ID })).count, 1);
  assert.equal((await mcp.callTool('sp_item_get', { listId: LIST_ID, itemId: '7' })).item.itemId, '7');
  assert.equal((await mcp.callTool('sp_permissions_get')).count, 1);
});

test('sp_item_query selects columns and filters the fetched page only, and says so', async () => {
  const { mcp } = runtimeWith(defaultRoutes);
  const payload = await mcp.callTool('sp_item_query', { listId: LIST_ID, top: 3, select: ['Title', 'Status'], filterField: 'Status', filterValue: '在籍' });
  assert.equal(payload.status, 'PASS');
  assert.equal(payload.count, 2);
  assert.equal(payload.filterScope, 'fetched_page_only');
  assert.deepEqual(payload.items[0].fields, { Title: 'A', Status: '在籍' });
  assert.equal(payload.items.some((item) => 'Secret' in item.fields), false);
});

test('sp_item_query refuses a filter field without a value', async () => {
  const { mcp } = runtimeWith(defaultRoutes);
  const payload = await mcp.callTool('sp_item_query', { listId: LIST_ID, filterField: 'Status' });
  assert.equal(payload.reasonCode, 'VALIDATION_FAILED');
});

test('sp_* tools reject malformed identifiers before any network call', async () => {
  const { mcp, calls } = runtimeWith(defaultRoutes);
  assert.equal((await mcp.callTool('sp_list_get', { listId: 'not-a-guid' })).reasonCode, 'VALIDATION_FAILED');
  assert.equal((await mcp.callTool('sp_item_get', { listId: LIST_ID, itemId: '0' })).reasonCode, 'VALIDATION_FAILED');
  assert.equal((await mcp.callTool('sp_item_query', { listId: LIST_ID, select: ['bad name;'] })).reasonCode, 'VALIDATION_FAILED');
  assert.equal(calls.length, 0);
});

test('a 403 from SharePoint becomes a FAIL with PERMISSION_DENIED and no token in the output', async () => {
  const { mcp } = runtimeWith({ [`/sites/hisyoengineer.sharepoint.com:/sites/cleannano`]: 403 });
  const payload = await mcp.callTool('sp_site_get');
  assert.equal(payload.status, 'FAIL');
  assert.equal(payload.reasonCode, 'PERMISSION_DENIED');
  assert.equal(JSON.stringify(payload).includes(TOKEN), false);
});

test('without a configured token the sp_* tools are BLOCKED and make no call', async () => {
  const mcp = createOperationsMcp({});
  const payload = await mcp.callTool('sp_lists_list');
  assert.equal(payload.status, 'BLOCKED');
  assert.equal(payload.reasonCode, 'ADAPTER_NOT_CONFIGURED');
  assert.equal(payload.executed, false);
});

test('sp_item_get and sp_permissions_get are audited before and after the call', async () => {
  const { mcp } = runtimeWith(defaultRoutes);
  const item = await mcp.callTool('sp_item_get', { listId: LIST_ID, itemId: '7' });
  const rows = await mcp.store.list('audit').filter((row) => row.tool === 'sp_item_get');
  assert.deepEqual(rows.map((row) => row.event), ['tool_started', 'tool_completed']);
  assert.ok(rows.every((row) => row.correlationId === item.correlationId));
});
