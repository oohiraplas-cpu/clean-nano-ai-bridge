'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, CONNECTOR_READONLY_TOOLS, PUBLISHED_TOOLS, MCP_PUBLIC_TOOLS, MCP_METHODS } = require('../src/server');
const { getConfig } = require('../src/config');
const { INTEGRATED_TOOL_NAMES, ALL_TOOL_NAMES, INTERNAL_ONLY_TOOL_NAMES } = require('../src/operationsMcp');
const { FACADES, DIRECT_TOOL_NAMES } = require('../src/toolVisibility');

const CN_KEY = 'cn-primary-key-AAAA1111';
const LEGACY_KEY = 'legacy-key-BBBB2222';
const CONNECTOR_KEY = 'connector-key-CCCC3333';

function configFor(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-int-'));
  return {
    config: getConfig({ TASKS_FILE: path.join(dir, 'tasks.json'), ...env }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

async function withApp(env, fn) {
  const { config, cleanup } = configFor(env);
  const app = createApp({ ...config, webhookApiKey: '' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); cleanup(); }
}

const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

// ---------- 認証変数（CN_MCP_API_KEY 優先 / MCP_API_KEY 後方互換） ----------

test('CN_MCP_API_KEY takes precedence over the legacy MCP_API_KEY', () => {
  const { config, cleanup } = configFor({ CN_MCP_API_KEY: CN_KEY, MCP_API_KEY: LEGACY_KEY });
  assert.equal(config.mcpApiKey, CN_KEY);
  assert.equal(config.mcpApiKeySource, 'CN_MCP_API_KEY');
  cleanup();
});

test('MCP_API_KEY is still accepted when CN_MCP_API_KEY is absent', () => {
  const { config, cleanup } = configFor({ MCP_API_KEY: LEGACY_KEY });
  assert.equal(config.mcpApiKey, LEGACY_KEY);
  assert.equal(config.mcpApiKeySource, 'MCP_API_KEY');
  cleanup();
});

test('when neither variable is set the key is empty and no source is reported', () => {
  const { config, cleanup } = configFor({});
  assert.equal(config.mcpApiKey, '');
  assert.equal(config.mcpApiKeySource, null);
  cleanup();
});

test('a request with the legacy key is refused when CN_MCP_API_KEY is the active key', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY, MCP_API_KEY: LEGACY_KEY }, async (base) => {
    const legacy = await post(`${base}/mcp`, rpc('tools/list'), { 'x-api-key': LEGACY_KEY });
    assert.equal(legacy.status, 401);
    const primary = await post(`${base}/mcp`, rpc('tools/list'), { 'x-api-key': CN_KEY });
    assert.equal(primary.status, 200);
  });
});

test('a legacy-only deployment keeps working with MCP_API_KEY', async () => {
  await withApp({ MCP_API_KEY: LEGACY_KEY }, async (base) => {
    const res = await post(`${base}/mcp`, rpc('tools/list'), { 'x-api-key': LEGACY_KEY });
    assert.equal(res.status, 200);
  });
});

test('the operations alias fails closed with 503 when no key is configured, and reveals nothing', async () => {
  await withApp({}, async (base) => {
    const res = await post(`${base}/mcp/operations`, rpc('tools/list'), {});
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.equal(text.includes('CN_MCP_API_KEY'), true);
    assert.equal(text.includes(LEGACY_KEY), false);
  });
});

test('/mcp fails closed (503) when no key is configured, without revealing key state', async () => {
  await withApp({}, async (base) => {
    const res = await post(`${base}/mcp`, rpc('tools/call', { name: 'authentication_check', arguments: {} }));
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.equal(text.includes('CN_MCP_API_KEY') && !text.includes('structuredContent'), true);
  });
});

test('authentication_check over /mcp never returns the key values', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY, MCP_API_KEY: LEGACY_KEY }, async (base) => {
    const res = await post(`${base}/mcp`, rpc('tools/call', { name: 'authentication_check', arguments: {} }), { 'x-api-key': CN_KEY });
    const text = await res.text();
    assert.equal(text.includes(CN_KEY), false);
    assert.equal(text.includes(LEGACY_KEY), false);
    assert.equal(JSON.parse(text).result.structuredContent.activeVariable, 'CN_MCP_API_KEY');
  });
});

// ---------- /mcp への統合 ----------

test('/mcp tools/list exposes every Clean Nano Operations tool, and no tool name appears twice', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    const res = await post(`${base}/mcp`, rpc('tools/list'), { 'x-api-key': CN_KEY });
    const names = (await res.json()).result.tools.map((tool) => tool.name);
    // 内部専用（files_manage 等）は公開しない。それ以外の統合ツールは全て公開する。
    const facadeTargets = new Set(FACADES.flatMap((f) => Object.values(f.ops).map((op) => op.tool)));
    const published = INTEGRATED_TOOL_NAMES.filter((name) => !INTERNAL_ONLY_TOOL_NAMES.includes(name) && !facadeTargets.has(name));
    for (const name of published) assert.ok(names.includes(name), name);
    // health_check など直接公開するツールは facade の対象でも公開を続ける（DIRECT_TOOL_NAMES）。
    const hidden = [...INTERNAL_ONLY_TOOL_NAMES, ...facadeTargets].filter((name) => !DIRECT_TOOL_NAMES.includes(name));
    for (const name of hidden) assert.equal(names.includes(name), false, name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.filter((name) => name === 'health_check').length, 1);
  });
});

test('the operations tools are part of the internal catalog and the method registry', () => {
  for (const name of INTEGRATED_TOOL_NAMES) {
    assert.ok(MCP_METHODS.includes(name), name);
    assert.ok(MCP_PUBLIC_TOOLS.some((tool) => tool.name === name), name);
    const facadeTargets = new Set(FACADES.flatMap((f) => Object.values(f.ops).map((op) => op.tool)));
    if (!INTERNAL_ONLY_TOOL_NAMES.includes(name) && !facadeTargets.has(name)) assert.ok(PUBLISHED_TOOLS.some((tool) => tool.name === name), name);
  }
  assert.ok(ALL_TOOL_NAMES.every((name) => MCP_PUBLIC_TOOLS.some((tool) => tool.name === name)));
});

test('/mcp tools/call runs a read tool and returns a structured, correlated result', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    const res = await post(`${base}/mcp`, rpc('tools/call', { name: 'version_get', arguments: { correlationId: 'int-trace-0001' } }), { 'x-api-key': CN_KEY });
    const json = await res.json();
    assert.equal(json.result.structuredContent.status, 'PASS');
    assert.equal(json.result.structuredContent.correlationId, 'int-trace-0001');
  });
});

test('/mcp tools/call returns BLOCKED with a reason for an unconfigured SharePoint read', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    const res = await post(`${base}/mcp`, rpc('tools/call', { name: 'sp_site_get', arguments: {} }), { 'x-api-key': CN_KEY });
    const payload = (await res.json()).result.structuredContent;
    assert.equal(payload.status, 'BLOCKED');
    assert.equal(payload.reasonCode, 'ADAPTER_NOT_CONFIGURED');
    assert.equal(payload.executed, false);
  });
});

test('/mcp tools/call rejects invalid arguments of an operations tool before running it', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    const res = await post(`${base}/mcp`, rpc('tools/call', { name: 'operation_plan', arguments: { operationType: 'nuke' } }), { 'x-api-key': CN_KEY });
    const payload = (await res.json()).result.structuredContent;
    assert.equal(payload.status, 'FAIL');
    assert.equal(payload.reasonCode, 'VALIDATION_FAILED');
  });
});

test('the legacy { method, params } form also reaches the operations tools', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    const res = await post(`${base}/mcp`, { method: 'version_get', params: {} }, { 'x-api-key': CN_KEY });
    const json = await res.json();
    assert.ok(json.result || json.error, 'a response is returned');
    if (json.result) assert.equal(json.result.status, 'PASS');
  });
});

test('an operation planned through /mcp can be dry-run through /mcp', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    const plan = await post(`${base}/mcp`, rpc('tools/call', {
      name: 'operation_plan',
      arguments: { operationType: 'read', targetEnvironmentId: 'env-1', targetObjectId: 'o-1', action: '確認' }
    }), { 'x-api-key': CN_KEY });
    const operationId = (await plan.json()).result.structuredContent.operationId;
    const dry = await post(`${base}/mcp`, rpc('tools/call', { name: 'dry_run', arguments: { operationId } }), { 'x-api-key': CN_KEY });
    assert.equal((await dry.json()).result.structuredContent.status, 'PASS');
  });
});

// ---------- 既存の接続の後方互換 ----------

test('/connector/mcp still lists only its five read-only tools', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY, CONNECTOR_API_KEY: CONNECTOR_KEY }, async (base) => {
    const res = await post(`${base}/connector/mcp?api_key=${CONNECTOR_KEY}`, rpc('tools/list'));
    const names = (await res.json()).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...CONNECTOR_READONLY_TOOLS].sort());
  });
});

test('/connector/mcp does not expose the operations tools to call', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY, CONNECTOR_API_KEY: CONNECTOR_KEY }, async (base) => {
    const res = await post(`${base}/connector/mcp?api_key=${CONNECTOR_KEY}`, rpc('tools/call', { name: 'version_get', arguments: {} }));
    const json = await res.json();
    assert.equal(json.error.code, -32601);
    assert.equal(json.result, undefined);
  });
});

test('/mcp/operations (compatibility alias) lists all operations tools with the same key', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    const res = await post(`${base}/mcp/operations`, rpc('tools/list'), { 'x-api-key': CN_KEY });
    const names = (await res.json()).result.tools.map((tool) => tool.name);
    assert.deepEqual([...names].sort(), ALL_TOOL_NAMES.filter((name) => !INTERNAL_ONLY_TOOL_NAMES.includes(name)).sort());
  });
});

test('/mcp/operations refuses a request without the key and accepts notifications with 202', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    assert.equal((await post(`${base}/mcp/operations`, rpc('tools/list'))).status, 401);
    const note = await post(`${base}/mcp/operations`, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'x-api-key': CN_KEY });
    assert.equal(note.status, 202);
  });
});

test('/mcp rejects an unauthenticated tools/call for an operations tool', async () => {
  await withApp({ CN_MCP_API_KEY: CN_KEY }, async (base) => {
    const res = await post(`${base}/mcp`, rpc('tools/call', { name: 'version_get', arguments: {} }));
    assert.equal(res.status, 401);
  });
});
