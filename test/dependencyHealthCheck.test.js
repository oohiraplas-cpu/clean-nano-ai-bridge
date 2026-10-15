const test = require('node:test');
const assert = require('node:assert/strict');
const { SharePointReader } = require('../src/sharePointReader');
const { PowerAutomateRunner } = require('../src/powerAutomateRunner');

function fakeFetch() {
  return async (url) => {
    if (String(url).includes('/oauth2/')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'site-1' }), text: async () => '' };
  };
}

test('SharePointReader.healthCheck: 設定不足は変数名だけ返す', async () => {
  const result = await new SharePointReader({}).healthCheck();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_configured');
  assert.ok(result.missingConfiguration.includes('SHAREPOINT_TENANT_ID'));
});

test('SharePointReader.healthCheck: 設定済みなら既定サイトの取得で ok', async () => {
  const reader = new SharePointReader({ tenantId: 'a', clientId: 'b', clientSecret: 'c', siteId: 'site-1', fetchImpl: fakeFetch() });
  assert.deepEqual(await reader.healthCheck(), { ok: true, status: 'ok' });
});

test('PowerAutomateRunner.healthCheck: フロー0件は not_configured、設定ありは ok（URLは実行しない）', async () => {
  assert.equal((await new PowerAutomateRunner({}).healthCheck()).status, 'not_configured');
  let called = false;
  const runner = new PowerAutomateRunner({ flows: { f1: 'https://example.invalid/x' }, fetchImpl: async () => { called = true; } });
  assert.deepEqual(await runner.healthCheck(), { ok: true, status: 'ok', flowCount: 1 });
  assert.equal(called, false);
});
