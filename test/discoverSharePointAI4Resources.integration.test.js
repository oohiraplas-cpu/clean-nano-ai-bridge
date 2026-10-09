const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');

test('discover_sharepoint_ai4_resources MCP integration', async (t) => {
  await t.test('returns error when SharePoint not configured', async () => {
    const config = getConfig({
      SHAREPOINT_TENANT_ID: '',
      SHAREPOINT_CLIENT_ID: '',
      SHAREPOINT_CLIENT_SECRET: ''
    });
    const app = createApp(config);
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const url = `http://127.0.0.1:${server.address().port}/mcp`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'discover_sharepoint_ai4_resources', arguments: {} }
        })
      });

      const result = await response.json();
      assert.ok(result.result?.isError, 'Should return error when not configured');
      assert.equal(result.result?.structuredContent?.status, 'not_configured');
      assert.match(result.result?.structuredContent?.reason || '', /SharePoint設定/);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('appears in tools/list', async () => {
    const config = getConfig({});
    const app = createApp(config);
    const server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const url = `http://127.0.0.1:${server.address().port}/mcp`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      });

      const result = await response.json();
      const tools = result.result.tools;
      const discoveryTool = tools.find(t => t.name === 'discover_sharepoint_ai4_resources');
      assert.ok(discoveryTool, 'discovery tool should be in tools list');
      assert.match(discoveryTool.description, /AI4/);
      assert.equal(discoveryTool.annotations.readOnlyHint, true);
      assert.equal(discoveryTool.annotations.destructiveHint, false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
