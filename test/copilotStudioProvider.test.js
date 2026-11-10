'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCopilotStudioProvider } = require('../src/oz/copilotStudioProvider');
const { createCopilotStudioAdapter } = require('../src/oz/copilotStudioAdapter');
test('Microsoft provider refuses unverified endpoints and absent auth without network calls', async () => {
  let calls = 0;
  const read = async () => { calls++; return { status: 'PASS' }; };
  const auth = async () => 'test-only-token';
  const target = { environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb', agentId: '1a93deb5-a45c-4572-9df3-96d6fc166d6b' };
  assert.equal((await createCopilotStudioProvider({ read, authorization: auth }).inspect(target)).reasonCode, 'VERIFIED_ENDPOINT_REQUIRED');
  assert.equal((await createCopilotStudioProvider({ read, authorization: auth, endpoints: { inspect: 'http://unsafe' } }).inspect(target)).reasonCode, 'VERIFIED_ENDPOINT_REQUIRED');
  assert.equal((await createCopilotStudioProvider({ read, endpoints: { inspect: 'https://example.invalid' } }).inspect(target)).reasonCode, 'MICROSOFT_AUTH_PROVIDER_MISSING');
  assert.equal(calls, 0);
});
test('Microsoft provider permits read only with explicit transport, auth and endpoint', async () => {
  let seen = 0;
  const provider = createCopilotStudioProvider({
    endpoints: { inspect: 'https://example.invalid/verified-by-test' },
    authorization: async () => 'test-only-token',
    read: async ({ method, token }) => {
      seen++; assert.equal(method, 'GET'); assert.equal(token, 'test-only-token');
      return { status: 'PASS', agent: 'CNAI' };
    }
  });
  const result = await createCopilotStudioAdapter(provider).invoke('inspect', {}, { authenticated: true });
  assert.equal(result.status, 'PASS');
  assert.equal(seen, 1);
  assert.equal((await createCopilotStudioAdapter(provider).invoke('applyDraft', {}, { authenticated: true })).reasonCode, 'MICROSOFT_PROVIDER_NOT_CONNECTED');
});
