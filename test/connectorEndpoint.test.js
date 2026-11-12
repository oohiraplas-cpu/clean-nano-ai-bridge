const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, CONNECTOR_READONLY_TOOLS, MCP_METHODS, PUBLISHED_TOOLS } = require('../src/server');
const { getConfig } = require('../src/config');
const { DIRECT_TOOL_NAMES } = require('../src/toolVisibility');
const { COPILOT_TOOL_NAMES } = require('../src/cnaiCopilotEntry');

async function startServer(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-endpoint-'));
  const config = getConfig({ MCP_API_KEY: 'master-key-1234', WEBHOOK_API_KEY: 'hook-key-1234', TASKS_FILE: path.join(dir, 'tasks.json'), ...env });
  const server = createApp(config).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

test('the connector allowlist contains only direct published read tools', () => {
  assert.deepEqual([...CONNECTOR_READONLY_TOOLS].sort(), [...DIRECT_TOOL_NAMES].sort());
  const published = new Set(PUBLISHED_TOOLS.map((tool) => tool.name));
  for (const name of CONNECTOR_READONLY_TOOLS) assert.ok(published.has(name), name);
});

test('without CONNECTOR_API_KEY the endpoint does not exist, even with a key in the URL', async () => {
  const { base, close } = await startServer();
  try {
    for (const url of [`${base}/connector/mcp`, `${base}/connector/mcp?api_key=`, `${base}/connector/mcp?api_key=master-key-1234`]) {
      const res = await post(url, rpc('tools/list'));
      assert.equal(res.status, 404, url);
    }
  } finally { await close(); }
});

test('wrong or missing key is rejected; the master key does not work here and the connector key does not work on /mcp', async () => {
  const { base, close } = await startServer({ CONNECTOR_API_KEY: 'connector-key-1234' });
  try {
    assert.equal((await post(`${base}/connector/mcp`, rpc('tools/list'))).status, 401);
    assert.equal((await post(`${base}/connector/mcp?api_key=wrong`, rpc('tools/list'))).status, 401);
    assert.equal((await post(`${base}/connector/mcp?api_key=master-key-1234`, rpc('tools/list'))).status, 401);
    assert.equal((await post(`${base}/mcp?api_key=connector-key-1234`, rpc('tools/list'))).status, 401);
    assert.equal((await post(`${base}/mcp?api_key=master-key-1234`, rpc('tools/list'))).status, 200);
  } finally { await close(); }
});

test('tools/list returns exactly the read-only tools plus the Copilot CNAI entry', async () => {
  const { base, close } = await startServer({ CONNECTOR_API_KEY: 'connector-key-1234' });
  try {
    const res = await post(`${base}/connector/mcp?api_key=connector-key-1234`, rpc('tools/list'));
    assert.equal(res.status, 200);
    const names = (await res.json()).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...CONNECTOR_READONLY_TOOLS, ...COPILOT_TOOL_NAMES].sort());
  } finally { await close(); }
});

test('initialize and ping work; the key may also be sent as a header', async () => {
  const { base, close } = await startServer({ CONNECTOR_API_KEY: 'connector-key-1234' });
  try {
    const init = await post(`${base}/connector/mcp?api_key=connector-key-1234`, rpc('initialize', { protocolVersion: '2025-06-18' }));
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.serverInfo.name, 'clean-nano-ai-bridge');
    const ping = await fetch(`${base}/connector/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'connector-key-1234' }, body: rpc('ping') });
    assert.equal(ping.status, 200);
  } finally { await close(); }
});

test('write and unlisted tools cannot be called through the connector', async () => {
  const { base, close } = await startServer({ CONNECTOR_API_KEY: 'connector-key-1234' });
  try {
    const url = `${base}/connector/mcp?api_key=connector-key-1234`;
    const forbidden = ['canvas_edit', 'canvas_save', 'canvas_publish', 'canvas_rollback', 'sharepoint', 'power_automate', 'deployment', 'update_powerapps_app', 'publish_powerapps_app', 'create_task', 'update_permissions', 'tasks'];
    for (const name of forbidden) {
      const res = await post(url, rpc('tools/call', { name, arguments: { operation: 'publish', approvedByHuman: true } }));
      const body = await res.json();
      assert.equal(res.status, 200, name);
      assert.equal(body.error?.code, -32601, name);
      assert.equal(body.result, undefined, name);
    }
  } finally { await close(); }
});

test('legacy method names and other JSON-RPC methods are not forwarded', async () => {
  const { base, close } = await startServer({ CONNECTOR_API_KEY: 'connector-key-1234' });
  try {
    const url = `${base}/connector/mcp?api_key=connector-key-1234`;
    for (const method of ['update_powerapps_app', 'publish_powerapps_app', 'create_task', 'resources/list', 'prompts/list']) {
      assert.ok(method !== 'resources/list' && method !== 'prompts/list' ? MCP_METHODS.includes(method) : true, method);
      const body = await (await post(url, rpc(method, {}))).json();
      assert.equal(body.error?.code, -32601, method);
    }
    const legacy = await post(url, JSON.stringify({ method: 'create_task', params: { title: 'x' } }));
    assert.equal(legacy.status, 400);
    const batch = await post(url, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]));
    assert.equal(batch.status, 400);
  } finally { await close(); }
});

test('an allowed read tool is executed through the shared MCP handler', async () => {
  const { base, close } = await startServer({ CONNECTOR_API_KEY: 'connector-key-1234' });
  try {
    const res = await post(`${base}/connector/mcp?api_key=connector-key-1234`, rpc('tools/call', { name: 'health_check', arguments: {} }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error, undefined);
    assert.ok(Array.isArray(body.result.content));
  } finally { await close(); }
});

test('invalid JSON on the connector route is a JSON-RPC parse error', async () => {
  const { base, close } = await startServer({ CONNECTOR_API_KEY: 'connector-key-1234' });
  try {
    const res = await post(`${base}/connector/mcp?api_key=connector-key-1234`, '{not json');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
  } finally { await close(); }
});

test('/mcp is fail-closed (503) when MCP_API_KEY is not configured, and still works with the key', async (t) => {
  const { createApp } = require('../src/server');
  const { getConfig } = require('../src/config');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const open = createApp(getConfig({})).listen(0, '127.0.0.1');
  await new Promise((r) => open.once('listening', r));
  t.after(() => open.close());
  const noKey = await fetch(`http://127.0.0.1:${open.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(noKey.status, 503);
  const keyed = createApp(getConfig({ MCP_API_KEY: 'k'.repeat(32) })).listen(0, '127.0.0.1');
  await new Promise((r) => keyed.once('listening', r));
  t.after(() => keyed.close());
  const base = `http://127.0.0.1:${keyed.address().port}/mcp`;
  assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k'.repeat(32) }, body })).status, 200);
});
