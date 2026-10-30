'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');

async function withServer(fn) {
  const app = createApp({ ...getConfig({}), mcpApiKey: 'k', webhookApiKey: '' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}/mcp`); } finally { server.close(); }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body });

test('any JSON-RPC notification (no id) is acknowledged with 202 and no body', async () => {
  await withServer(async (url) => {
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/roots/list_changed']) {
      const res = await post(url, JSON.stringify({ jsonrpc: '2.0', method }));
      assert.equal(res.status, 202, method);
      assert.equal(await res.text(), '', method);
    }
  });
});

test('unknown JSON-RPC requests (with id) still get Method not found', async () => {
  await withServer(async (url) => {
    const res = await post(url, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }));
    assert.equal((await res.json()).error.code, -32601);
  });
});

test('malformed JSON on /mcp returns a JSON-RPC -32700 parse error, not a 500', async () => {
  await withServer(async (url) => {
    const res = await post(url, '{bad');
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.jsonrpc, '2.0');
    assert.equal(json.error.code, -32700);
  });
});
