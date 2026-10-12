'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FIELDS, SharePointApprovalStore, ScopedApprovalExecutor } = require('../src/scopedApprovalExecution');

const fieldMap = Object.fromEntries(FIELDS.map(k => [k, k]));
function storeWith({ actor = { user: { id: 'human-1' } }, user = { id: 'human-1', accountEnabled: true }, responseStatus = 200 } = {}) {
  const calls = [];
  const reader = {
    graphBaseUrl: 'https://graph.microsoft.com/v1.0',
    _assertConfig() {},
    async _getAccessToken() { return 'test-token'; },
    async _fetch(url, options) {
      calls.push({ url, options });
      const body = url.includes('/users/') ? user : { id: '1', eTag: '"v1"', lastModifiedBy: actor,
        fields: Object.fromEntries(FIELDS.map(k => [k, null])) };
      return { ok: responseStatus < 400, status: responseStatus, async json() { return body; } };
    }
  };
  return { store: new SharePointApprovalStore(reader, {
    siteId: 'site-id', listId: 'list-id', fieldMap, allowedApproverIds: ['human-1']
  }), calls };
}

test('schema contract requires exactly 15 unique mapped fields', () => {
  assert.equal(FIELDS.length, 15);
  assert.equal(new Set(FIELDS).size, 15);
  const { store } = storeWith();
  assert.doesNotThrow(() => store.assertConfigured());
  delete store.config.fieldMap.backup;
  assert.throws(() => store.assertConfigured());
});

test('approval metadata must be attributed to an independent enabled human', async () => {
  const { store } = storeWith();
  const snapshot = { record: { approverId: 'human-1' }, actor: { user: { id: 'human-1' } } };
  assert.equal(await store.verifyHuman(snapshot), true);
  assert.equal(await store.verifyHuman({ ...snapshot, actor: { application: { id: 'service' }, user: { id: 'human-1' } } }), false);
  assert.equal(await store.verifyHuman({ ...snapshot, actor: { user: { id: 'other' } } }), false);
  assert.equal(await store.verifyHuman({ ...snapshot, record: { approverId: 'other' } }), false);
  const disabled = storeWith({ user: { id: 'human-1', accountEnabled: false } });
  assert.equal(await disabled.store.verifyHuman(snapshot), false);
});

test('reservation PATCH requires ETag and cannot edit human decision fields', async () => {
  const { store, calls } = storeWith();
  await assert.rejects(store.patch('1', '', { executionId: 'e1' }));
  await assert.rejects(store.patch('1', '*', { executionId: 'e1' }));
  await assert.rejects(store.patch('1', '"v1"', { status: '承認' }));
  await store.patch('1', '"v1"', { executionId: 'e1', executionStatus: 'reserved' });
  const patch = calls.find(x => x.options.method === 'PATCH');
  assert.equal(patch.options.headers['If-Match'], '"v1"');
  assert.deepEqual(JSON.parse(patch.options.body), { executionId: 'e1', executionStatus: 'reserved' });
});

test('Graph 412 ETag conflict is fail-closed', async () => {
  const { store } = storeWith({ responseStatus: 412 });
  await assert.rejects(store.patch('1', '"old"', { executionId: 'e1' }), /etag_conflict/);
});

test('approval validity requires explicit false revocation and <=24h UTC window', () => {
  const { store } = storeWith();
  const now = Date.parse('2026-10-13T10:00:00Z');
  const executor = new ScopedApprovalExecutor({ store, commitSha: 'a'.repeat(40), now: () => now });
  const input = { requestId: 'r', tool: 't', targetId: 'target', environmentId: 'env',
    commitSha: 'a'.repeat(40), diffHash: 'b'.repeat(64) };
  const record = { ...input, status: '承認', revoked: false,
    approvedAt: '2026-10-13T09:00:00Z', expiresAt: '2026-10-13T11:00:00Z',
    executionId: '', executionStatus: '' };
  // Stub only the payload-hash calculation for this isolated validation test.
  const { changeHash } = require('../src/scopedApprovalExecution');
  input.params = {};
  input.diffHash = changeHash(input);
  record.diffHash = input.diffHash;
  assert.doesNotThrow(() => executor.validate(record, input));
  for (const revoked of [null, 'false', true]) {
    assert.throws(() => executor.validate({ ...record, revoked }, input));
  }
  assert.throws(() => executor.validate({ ...record, expiresAt: '2026-10-14T12:00:00Z' }, input));
  assert.throws(() => executor.validate({ ...record, approvedAt: 'invalid' }, input));
  assert.throws(() => executor.validate({ ...record, executionId: 'used' }, input));
});
