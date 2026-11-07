'use strict';
// Webhook 認証の移行: compat（既存挙動）と enforce（fail closed）の両方を確認する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, WEBHOOK_PATHS } = require('../src/server');
const { getConfig } = require('../src/config');

const WEBHOOK_KEY = 'webhook-lane-f-key-WWWW8001';

async function withApp(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-'));
  fs.writeFileSync(path.join(dir, 'tasks.json'), '[]\n');
  const config = getConfig({ TASKS_FILE: path.join(dir, 'tasks.json'), ...env });
  const app = createApp(config);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const post = (base, route, headers = {}) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ id: 'wh-test-1', title: 'webhook test' })
});

test('the webhook route inventory is the two known routes', () => {
  assert.deepEqual([...WEBHOOK_PATHS], ['/webhooks/claude-code', '/webhooks/copilot']);
});

test('the default mode is compat, so the existing behaviour is unchanged', () => {
  assert.equal(getConfig({}).webhookAuthMode, 'compat');
  assert.equal(getConfig({ WEBHOOK_AUTH_MODE: 'something-else' }).webhookAuthMode, 'compat');
});

test('compat: with no key configured, webhooks still accept requests as before', async () => {
  await withApp({}, async (base) => {
    for (const route of WEBHOOK_PATHS) assert.equal((await post(base, route)).status, 202, route);
  });
});

test('compat: with a key configured, a missing or wrong key is refused', async () => {
  await withApp({ WEBHOOK_API_KEY: WEBHOOK_KEY }, async (base) => {
    for (const route of WEBHOOK_PATHS) {
      assert.equal((await post(base, route)).status, 401, route);
      assert.equal((await post(base, route, { 'x-api-key': 'wrong-value-here' })).status, 401, route);
      assert.equal((await post(base, route, { 'x-api-key': WEBHOOK_KEY })).status, 202, route);
    }
  });
});

test('enforce: with no key configured, every webhook fails closed with 503 and creates nothing', async () => {
  await withApp({ WEBHOOK_AUTH_MODE: 'enforce' }, async (base) => {
    for (const route of WEBHOOK_PATHS) {
      const res = await post(base, route, { 'x-api-key': 'anything' });
      assert.equal(res.status, 503, route);
      const text = await res.text();
      assert.equal(text.includes('anything'), false);
    }
  });
});

test('enforce: with a key configured, behaviour matches compat', async () => {
  await withApp({ WEBHOOK_AUTH_MODE: 'enforce', WEBHOOK_API_KEY: WEBHOOK_KEY }, async (base) => {
    assert.equal((await post(base, '/webhooks/copilot')).status, 401);
    assert.equal((await post(base, '/webhooks/copilot', { 'x-api-key': WEBHOOK_KEY })).status, 202);
  });
});

test('enforce does not affect the MCP routes, which have their own key gate', async () => {
  await withApp({ WEBHOOK_AUTH_MODE: 'enforce' }, async (base) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 503);
  });
});
