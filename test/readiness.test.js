const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('../src/server');

async function callReadiness(config, store) {
  const server = await new Promise((resolve) => {
    const instance = createApp(config, store).listen(0, () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'key-value' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_bridge_readiness', arguments: {} } })
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test('診断は実際の保存先だけ疎通確認し、認証情報を返さない', async () => {
  const config = {
    corsOrigins: [], mcpApiKey: 'key-value', webhookApiKey: 'webhook-secret', taskStoreBackend: 'sharepoint',
    sharepoint: { tenantId: 'tenant-secret', clientId: 'client-secret', clientSecret: 'sp-secret', siteId: 'site-secret', listId: 'list-secret' },
    powerApps: { tenantId: 'tenant-secret', clientId: 'client-secret', clientSecret: 'app-secret', environmentId: 'env-secret', appId: 'app-id-secret' },
    powerAutomate: { flows: { dailyReport: 'https://secret.example/trigger' } }
  };
  const { status, body } = await callReadiness(config, { list: async () => [{ id: '1' }] });
  assert.equal(status, 200);
  assert.equal(body.result.structuredContent.configured.taskBackend, 'sharepoint');
  assert.equal(body.result.structuredContent.probes.taskStore.status, 'reachable');
  assert.equal(body.result.structuredContent.probes.taskStore.count, 1);
  assert.deepEqual(body.result.structuredContent.configured.powerAutomateFlowKeys, ['dailyReport']);
  assert.equal(body.result.structuredContent.configured.powerApps, true);
  assert.doesNotMatch(JSON.stringify(body), /secret|key-value|trigger/);
});

test('保存先の障害は安全にunavailableと報告する', async () => {
  const { body } = await callReadiness({ corsOrigins: [], mcpApiKey: 'key-value', sharepoint: {}, powerApps: {}, powerAutomate: {} }, {
    list: async () => { throw new Error('sensitive upstream URL https://secret.example'); }
  });
  assert.equal(body.result.structuredContent.probes.taskStore.status, 'unavailable');
  assert.equal(body.result.structuredContent.configured.sharepointTasks, false);
  assert.doesNotMatch(JSON.stringify(body), /sensitive|secret.example/);
});
