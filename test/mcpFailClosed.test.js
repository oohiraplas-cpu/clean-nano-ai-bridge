'use strict';
// Lane A: MCP 認証の fail-closed 化と CN_MCP_API_KEY 優先・MCP_API_KEY 後方互換の移行試験。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, CONNECTOR_READONLY_TOOLS } = require('../src/server');
const { getConfig, resolveMcpApiKey } = require('../src/config');
const { ConfigurationValidator } = require('../src/productionReadiness');

const CN_KEY = 'cn-lane-a-key-XXXX9001';
const LEGACY_KEY = 'legacy-lane-a-key-YYYY9002';
const CONNECTOR_KEY = 'connector-lane-a-key-ZZZZ9003';

async function withApp(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fc-'));
  const config = getConfig({ TASKS_FILE: path.join(dir, 'tasks.json'), ...env });
  const app = createApp({ ...config, webhookApiKey: '' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const rpcBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
const postMcp = (base, endpoint, headers = {}) => fetch(`${base}${endpoint}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(rpcBody)
});

// --- 設定解決（CN_MCP_API_KEY 優先・MCP_API_KEY 後方互換） ---

test('resolveMcpApiKey prefers CN_MCP_API_KEY over the legacy name', () => {
  const r = resolveMcpApiKey({ CN_MCP_API_KEY: CN_KEY, MCP_API_KEY: LEGACY_KEY });
  assert.equal(r.key, CN_KEY);
  assert.equal(r.source, 'CN_MCP_API_KEY');
});

test('resolveMcpApiKey falls back to MCP_API_KEY only when CN_MCP_API_KEY is unset', () => {
  const r = resolveMcpApiKey({ MCP_API_KEY: LEGACY_KEY });
  assert.equal(r.key, LEGACY_KEY);
  assert.equal(r.source, 'MCP_API_KEY');
});

test('resolveMcpApiKey returns no key and no source when both are unset or empty', () => {
  assert.deepEqual(resolveMcpApiKey({}), { key: '', source: null });
  assert.deepEqual(resolveMcpApiKey({ CN_MCP_API_KEY: '', MCP_API_KEY: '' }), { key: '', source: null });
});

test('getConfig carries the resolved key and its source name, never a second copy', () => {
  const config = getConfig({ CN_MCP_API_KEY: CN_KEY, MCP_API_KEY: LEGACY_KEY });
  assert.equal(config.mcpApiKey, CN_KEY);
  assert.equal(config.mcpApiKeySource, 'CN_MCP_API_KEY');
});

// --- fail-closed（未設定なら /mcp 系すべて拒否） ---

test('with no MCP key, every /mcp route refuses with 503 and never reveals key state', async () => {
  await withApp({}, async (base) => {
    const checks = [
      await postMcp(base, '/mcp'),
      await postMcp(base, '/mcp/operations'),
      await fetch(`${base}/mcp/tools/list`),
      await fetch(`${base}/mcp`),
    ];
    for (const res of checks) {
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.equal(text.includes(CN_KEY) || text.includes(LEGACY_KEY), false);
    }
  });
});

test('a request that carries a key is still refused with 503 when no key is configured', async () => {
  await withApp({}, async (base) => {
    const res = await postMcp(base, '/mcp', { 'x-api-key': 'anything-at-all' });
    assert.equal(res.status, 503);
  });
});

test('with CN_MCP_API_KEY set, /mcp refuses missing or wrong keys with 401', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    assert.equal((await postMcp(base, '/mcp')).status, 401);
    assert.equal((await postMcp(base, '/mcp', { 'x-api-key': 'wrong-key-value' })).status, 401);
    assert.equal((await postMcp(base, '/mcp/operations', { 'x-api-key': LEGACY_KEY })).status, 401);
  });
});

test('with CN_MCP_API_KEY set, the correct key is accepted on /mcp and /mcp/operations', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    assert.equal((await postMcp(base, '/mcp', { 'x-api-key': CN_KEY })).status, 200);
    assert.equal((await postMcp(base, '/mcp/operations', { 'x-api-key': CN_KEY })).status, 200);
    assert.equal((await postMcp(base, '/mcp', { authorization: `Bearer ${CN_KEY}` })).status, 200);
  });
});

test('migration: MCP_API_KEY alone keeps existing clients working', async () => {
  await withApp({ MCP_API_KEY: LEGACY_KEY }, async (base) => {
    assert.equal((await postMcp(base, '/mcp', { 'x-api-key': LEGACY_KEY })).status, 200);
    assert.equal((await postMcp(base, '/mcp', { 'x-api-key': 'nope-nope-nope' })).status, 401);
  });
});

test('migration: when CN_MCP_API_KEY is set, the legacy value no longer authenticates', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY, MCP_API_KEY: LEGACY_KEY }, async (base) => {
    assert.equal((await postMcp(base, '/mcp', { 'x-api-key': LEGACY_KEY })).status, 401);
  });
});

// --- /connector/mcp への既存影響なし ---

test('/mcp fail-closed does not affect the connector endpoint, which keeps its own key', async () => {
  await withApp({ CONNECTOR_API_KEY: CONNECTOR_KEY }, async (base) => {
    // MCP 鍵が無いので /mcp は 503 だが、コネクタ窓口は独立して動く。
    assert.equal((await postMcp(base, '/mcp')).status, 503);
    const res = await fetch(`${base}/connector/mcp?api_key=${CONNECTOR_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpcBody)
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.result.tools.length, CONNECTOR_READONLY_TOOLS.length);
  });
});

test('the connector endpoint never accepts the MCP key', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY, CONNECTOR_API_KEY: CONNECTOR_KEY }, async (base) => {
    const res = await fetch(`${base}/connector/mcp?api_key=${CN_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpcBody)
    });
    assert.equal(res.status, 401);
  });
});

// --- 起動前チェック（productionReadiness） ---

test('readiness reports an error only when neither key name is set, and never prints a value', () => {
  const v = new ConfigurationValidator();
  const issues = (env) => { const i = { errors: [], warnings: [], recommendations: [] }; v._validateSecurityConfigs(env, i); return i; };
  const none = issues({ WEBHOOK_API_KEY: 'w'.repeat(40) });
  assert.ok(none.errors.some((e) => e.includes('CN_MCP_API_KEY')));
  const cn = issues({ WEBHOOK_API_KEY: 'w'.repeat(40), CN_MCP_API_KEY: CN_KEY });
  assert.equal(cn.errors.some((e) => e.includes('CN_MCP_API_KEY')), false);
  const legacy = issues({ WEBHOOK_API_KEY: 'w'.repeat(40), MCP_API_KEY: LEGACY_KEY });
  assert.equal(legacy.errors.some((e) => e.includes('CN_MCP_API_KEY')), false);
  const serialized = JSON.stringify([cn, legacy]);
  assert.equal(serialized.includes(CN_KEY) || serialized.includes(LEGACY_KEY), false);
});
