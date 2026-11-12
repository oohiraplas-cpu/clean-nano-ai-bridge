const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');
const cnaiRouter = require('../src/cnaiRouter');
const { verifyRouterRecord } = require('../src/cnaiRouterVerifier');
const entryModule = require('../src/cnaiCopilotEntry');

const KEY = 'connector-key-1234';
const SECRET = 'sk-test-0123456789abcdefghijklmnop';

function fakeReader({ drift = false, fail = null } = {}) {
  let reads = 0;
  return {
    async listItems(params) {
      if (fail) throw Object.assign(new Error(fail.message || 'x'), { status: fail.status });
      reads += 1;
      return {
        status: 'ok', siteId: 'site-1', listId: params.listId || 'list-1', count: 1, hasMore: false,
        columns: [{ name: 'Title', displayName: 'タイトル', type: 'text' }],
        items: [{ itemId: '1', fields: { Title: `row-${drift ? reads : 1}`, token: SECRET } }]
      };
    },
    async listLists() { return { lists: [{ id: 'list-1', displayName: 'L' }] }; }
  };
}

async function start(reader, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-entry-'));
  const config = getConfig({ MCP_API_KEY: 'master-key-1234', WEBHOOK_API_KEY: 'hook-key-1234', CONNECTOR_API_KEY: KEY, DEPLOYMENT_SHA: 'abc1234', TASKS_FILE: path.join(dir, 'tasks.json'), ...env });
  const server = createApp(config, undefined, undefined, undefined, reader).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/connector/mcp`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

let seq = 0;
async function call(url, name, args, key = KEY) {
  const res = await fetch(`${url}${key === null ? '' : `?api_key=${key}`}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } })
  });
  const body = await res.json().catch(() => null);
  return { http: res.status, body, data: body && body.result && body.result.structuredContent };
}

const uid = (p) => `${p}-${Date.now()}-${++seq}`;

test('tools/list on the connector exposes cnai_status and cnai_route_request with read-only schemas', async () => {
  const { url, close } = await start(fakeReader());
  try {
    const res = await fetch(`${url}?api_key=${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = (await res.json()).result.tools;
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('cnai_status') && names.includes('cnai_route_request'));
    const route = tools.find((t) => t.name === 'cnai_route_request');
    assert.deepEqual(route.inputSchema.required, ['requestId', 'operation', 'target']);
    assert.deepEqual(route.inputSchema.properties.operation.enum, ['read', 'list', 'status']);
    assert.ok(!names.includes('cnai_submit_windows_job') && !names.includes('cnai_rollback_route'));
  } finally { await close(); }
});

test('auth: no key / wrong key are rejected with 401 and never reach the tools', async () => {
  const { url, close } = await start(fakeReader());
  try {
    assert.equal((await call(url, 'cnai_status', {}, null)).http, 401);
    assert.equal((await call(url, 'cnai_status', {}, 'wrong-key')).http, 401);
    assert.equal((await call(url, 'cnai_route_request', { requestId: uid('r'), operation: 'read', target: 'sharepoint', payload: { listId: 'l' } }, 'wrong-key')).http, 401);
  } finally { await close(); }
});

test('cnai_status: reachable, version, deployment SHA, verificationStatus, no secrets', async () => {
  const { url, close } = await start(fakeReader());
  try {
    const { http, data } = await call(url, 'cnai_status', {});
    assert.equal(http, 200);
    assert.equal(data.status, 'ok');
    assert.equal(data.router.reachable, true);
    assert.equal(data.bridgeMax.reachable, true);
    assert.equal(data.deploymentSha, 'abc1234');
    assert.equal(data.verificationStatus, 'VERIFIED');
    assert.ok(!JSON.stringify(data).includes(KEY));
  } finally { await close(); }
  const none = await start(fakeReader(), { DEPLOYMENT_SHA: '' });
  try {
    const { data } = await call(none.url, 'cnai_status', {});
    assert.equal(data.deploymentSha, null);
    assert.equal(data.verificationStatus, 'UNVERIFIED');
  } finally { await none.close(); }
});

test('sharepoint READ with read-back: COMPLETED/VERIFIED, ids present, secrets masked', async () => {
  const { url, close } = await start(fakeReader());
  try {
    const requestId = uid('sp');
    const correlationId = uid('corr');
    const { data } = await call(url, 'cnai_route_request', { requestId, correlationId, operation: 'read', target: 'sharepoint', payload: { listId: 'list-1' } });
    assert.equal(data.status, 'COMPLETED');
    assert.equal(data.verificationStatus, 'VERIFIED');
    assert.equal(data.selectedRoute, 'sharepoint');
    assert.equal(data.requestId, requestId);
    assert.equal(data.correlationId, correlationId);
    assert.ok(data.auditId);
    assert.equal(data.readBackResult.matched, true);
    assert.equal(data.result.columns[0].type, 'text');
    assert.ok(!JSON.stringify(data).includes(SECRET), 'secret must be masked');
  } finally { await close(); }
});

test('a read-back mismatch is PARTIAL/UNVERIFIED, never VERIFIED', async () => {
  const { url, close } = await start(fakeReader({ drift: true }));
  try {
    const { data } = await call(url, 'cnai_route_request', { requestId: uid('drift'), operation: 'read', target: 'sharepoint', payload: { listId: 'list-1' } });
    assert.equal(data.status, 'PARTIAL');
    assert.equal(data.verificationStatus, 'UNVERIFIED');
    assert.equal(data.readBackResult.matched, false);
  } finally { await close(); }
});

test('idempotency: the same requestId is not executed twice', async () => {
  const { url, close } = await start(fakeReader());
  try {
    const args = { requestId: uid('idem'), operation: 'read', target: 'sharepoint', payload: { listId: 'list-1' } };
    const a = await call(url, 'cnai_route_request', args);
    const b = await call(url, 'cnai_route_request', args);
    assert.equal(b.data.duplicate, true);
    assert.equal(b.data.auditId, a.data.auditId);
  } finally { await close(); }
});

test('READ-only gate: write operations, windowsExecutor and unknown properties are rejected before routing', async () => {
  const { url, close } = await start(fakeReader());
  try {
    for (const args of [
      { requestId: uid('w'), operation: 'update', target: 'sharepoint', payload: {} },
      { requestId: uid('w'), operation: 'create', target: 'sharepoint', payload: {} },
      { requestId: uid('w'), operation: 'read', target: 'windowsExecutor', payload: {} },
      { requestId: uid('w'), operation: 'read', target: 'blockedPaidRoute', payload: {} },
      { requestId: uid('w'), operation: 'read', target: 'sharepoint', riskLevel: 'HIGH' }
    ]) {
      const { data } = await call(url, 'cnai_route_request', args);
      assert.equal(data.status, 'REJECTED', JSON.stringify(args));
      assert.equal(data.verificationStatus, 'UNVERIFIED');
      assert.ok(['READ_ONLY_VIOLATION', 'INVALID_REQUEST'].includes(data.errorCode));
    }
    const bad = await call(url, 'cnai_route_request', { operation: 'read', target: 'sharepoint' });
    assert.equal(bad.data.errorCode, 'INVALID_REQUEST');
  } finally { await close(); }
});

test('upstream 401/403/404/timeout are normalized and never VERIFIED', async () => {
  const cases = [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND']];
  for (const [status, code] of cases) {
    const { url, close } = await start(fakeReader({ fail: { status, message: `HTTP ${status} ${SECRET}` } }));
    try {
      const { data } = await call(url, 'cnai_route_request', { requestId: uid('e'), operation: 'read', target: 'sharepoint', payload: { listId: 'x' } });
      assert.equal(data.errorCode, code);
      assert.equal(data.verificationStatus, 'FAILED');
      assert.ok(!JSON.stringify(data).includes(SECRET));
    } finally { await close(); }
  }
  const { url, close } = await start(fakeReader({ fail: { message: 'request timed out' } }));
  try {
    const { data } = await call(url, 'cnai_route_request', { requestId: uid('t'), operation: 'read', target: 'sharepoint', payload: { listId: 'x' } });
    assert.equal(data.errorCode, 'UPSTREAM_TIMEOUT');
    assert.notEqual(data.verificationStatus, 'VERIFIED');
  } finally { await close(); }
});

test('operationsMcp only runs allowlisted read tools (health_check works, writes are refused)', async () => {
  const { url, close } = await start(fakeReader());
  try {
    const ok = await call(url, 'cnai_route_request', { requestId: uid('o'), operation: 'read', target: 'operationsMcp', payload: { tool: 'health_check' } });
    assert.equal(ok.data.status, 'COMPLETED');
    assert.equal(ok.data.selectedRoute, 'operationsMcp');
    const bad = await call(url, 'cnai_route_request', { requestId: uid('o'), operation: 'read', target: 'operationsMcp', payload: { tool: 'update_sharepoint_list_item', arguments: {} } });
    assert.notEqual(bad.data.status, 'COMPLETED');
    assert.equal(bad.data.errorCode, 'READ_ONLY_VIOLATION');
  } finally { await close(); }
});

test('the Independent Verifier accepts the router record produced by the Copilot entry', async () => {
  const state = cnaiRouter.createRouterState();
  const entry = entryModule.createCopilotEntry({ state, reader: fakeReader(), executeReadTool: async () => ({ status: 'ok' }), config: { deploymentSha: 'abc1234' } });
  const out = await entry.route({ requestId: uid('v'), operation: 'read', target: 'sharepoint', payload: { listId: 'list-1' } });
  const [internalId] = [...state.requests.keys()];
  const verdict = verifyRouterRecord(
    cnaiRouter.getStatus(state, internalId),
    cnaiRouter.getAuditTrail(state, internalId),
    cnaiRouter.getCheckpoint(state, internalId)
  );
  assert.equal(out.status, 'COMPLETED');
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.ok, true);
});

test('the windowsExecutor route is not reachable from the Copilot entry', async () => {
  const entry = entryModule.createCopilotEntry({ reader: fakeReader(), executeReadTool: async () => ({}), config: {} });
  const out = await entry.route({ requestId: uid('x'), operation: 'read', target: 'windowsExecutor' });
  assert.equal(out.status, 'REJECTED');
});
