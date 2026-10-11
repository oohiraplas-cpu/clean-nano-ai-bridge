const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { createApp, MCP_METHODS, MCP_PUBLIC_TOOLS } = require('../src/server');
const { getConfig } = require('../src/config');

test('OpenAPI and connector snapshot match all dispatched MCP tools and session schemas', () => {
  const spec = yaml.load(fs.readFileSync(path.join(__dirname, '../openapi.yaml'), 'utf8'));
  const snapshot = require('../config/mcp-public-tools.json');
  assert.deepEqual(snapshot.tools, MCP_PUBLIC_TOOLS);
  assert.deepEqual([...spec.components.schemas.McpInput.properties.method.enum].sort(), [...MCP_METHODS].sort());
  assert.deepEqual([...MCP_METHODS].sort(), MCP_PUBLIC_TOOLS.map(t => t.name).sort());
  const source = snapshot.tools.find(t => t.name === 'get_powerapps_source');
  for (const key of ['correlationId', 'stateSessionId']) assert.equal(source.inputSchema.properties[key].type, 'string');
  for (const name of ['validate_powerapps_source', 'compare_powerapps_with_git']) {
    assert.ok(snapshot.tools.find(t => t.name === name).inputSchema.required.includes('stateSessionId'));
  }
});

test('GET and JSON-RPC tools/list expose the same authoritative registry', async t => {
  const app = createApp(getConfig({ MCP_API_KEY: 'contract-test-key' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-api-key': 'contract-test-key', 'content-type': 'application/json' };
  const get = await fetch(`${base}/mcp/tools/list`, { headers });
  assert.equal(get.status, 200);
  assert.deepEqual((await get.json()).tools, MCP_PUBLIC_TOOLS);
  const rpc = await fetch(`${base}/mcp`, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(rpc.status, 200);
  assert.deepEqual((await rpc.json()).result.tools, MCP_PUBLIC_TOOLS);
});
