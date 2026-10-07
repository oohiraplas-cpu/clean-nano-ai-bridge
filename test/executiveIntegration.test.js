const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp, MCP_PUBLIC_TOOLS } = require('../src/server');

test('Executive MCP tools are authenticated, discoverable and executable through the actual HTTP handler', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cnai-executive-'));
  const app = createApp({ corsOrigins: [], tasksFile: path.join(directory, 'tasks.json'), mcpApiKey: 'test-only-executive-key', powerApps: {}, sharepoint: {}, powerAutomate: { flows: {} } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const call = async (method, params, authorized = true) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-api-key': 'test-only-executive-key' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('tools/list', {}, false)).status, 401);
  const listed = await call('tools/list', {});
  assert.equal(listed.body.result.tools.length, MCP_PUBLIC_TOOLS.length);
  for (const name of ['get_executive_policy', 'get_executive_brief']) {
    assert.equal(MCP_PUBLIC_TOOLS.find(x => x.name === name).annotations.readOnlyHint, true);
    const result = (await call('tools/call', { name, arguments: {} })).body.result;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.data.calculatedValues?.length ?? 0, 0);
  }
  const brief = (await call('tools/call', { name: 'get_executive_brief', arguments: { sources: [{ metric: '売上', listName: 'unconfigured', field: 'Amount' }] } })).body.result;
  assert.equal(brief.structuredContent.verified, false);
  assert.equal(brief.structuredContent.data.originalValues.length, 0);
  const invalid = (await call('tools/call', { name: 'get_executive_brief', arguments: { sources: [{ metric: '売上', listName: 'existing', field: 'Amount', top: 201 }] } })).body.result;
  assert.equal(invalid.isError, true);
  assert.match(invalid.structuredContent.error, /top/);
});
