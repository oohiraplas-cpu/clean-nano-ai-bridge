'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAtomicApprovalReservation } = require('../src/atomicApprovalReservation');
const now = Date.parse('2026-10-13T00:00:00Z');
const sha = 'a'.repeat(40), hash = 'b'.repeat(64);
const context = { approvalId: '7', requestId: 'req-1', operation: 'deploy', targetSha: sha, appId: 'app-1', environmentId: 'env-1', changeHash: hash };
function fixture(overrides = {}) {
  const record = { requestId: 'req-1', tool: 'deploy', targetId: 'app-1', environmentId: 'env-1',
    commitSha: sha, diffHash: hash, approvedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(), status: '承認', revoked: false };
  let version = 1, patches = 0;
  const store = {
    async read() { return { etag: String(version), record: { ...record } }; },
    async verifyHuman() { return true; },
    async patch(id, etag, values) {
      if (etag !== String(version)) throw new Error('412');
      patches++; Object.assign(record, values); version++;
    }
  };
  Object.assign(record, overrides);
  return { store, record, patches: () => patches };
}
test('ETag reservation is single-use, duplicate request is denied', async () => {
  const f = fixture(), reserve = createAtomicApprovalReservation({ store: f.store, now: () => now });
  const first = await reserve(context), second = await reserve(context);
  assert.equal(first.reserved, true);
  assert.equal(first.singleUseVerified, true);
  assert.equal(second.reserved, false);
  assert.equal(f.patches(), 1);
});
test('revoked and expired approvals fail before any patch', async () => {
  for (const override of [{ revoked: true }, { expiresAt: new Date(now - 1).toISOString() }]) {
    const f = fixture(override), result = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
    assert.equal(result.reserved, false); assert.equal(f.patches(), 0);
  }
});
test('ETag conflict fails closed and never retries', async () => {
  const f = fixture();
  f.store.patch = async () => { throw new Error('412 Precondition Failed'); };
  const result = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  assert.equal(result.reserved, false);
});
test('post-write read failure never returns a usable reservation', async () => {
  const f = fixture(); let reads = 0; const read = f.store.read;
  f.store.read = async () => { if (++reads === 2) throw new Error('network'); return read(); };
  const result = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  assert.equal(result.reserved, false); assert.equal(f.patches(), 1);
});
test('approval identity and exact target binding are required', async () => {
  const f = fixture(); f.store.verifyHuman = async () => false;
  assert.equal((await createAtomicApprovalReservation({ store: f.store, now: () => now })(context)).reserved, false);
  const g = fixture();
  assert.equal((await createAtomicApprovalReservation({ store: g.store, now: () => now })({ ...context, targetSha: 'c'.repeat(40) })).reserved, false);
  assert.equal(g.patches(), 0);
});

test('post-reservation revocation or expiry fails closed without retry', async () => {
  for (const mutate of [
    record => { record.revoked = true; },
    record => { record.expiresAt = new Date(now - 1).toISOString(); },
    record => { record.targetId = 'other-app'; },
    record => { record.diffHash = 'c'.repeat(64); }
  ]) {
    const f = fixture(), patch = f.store.patch;
    f.store.patch = async (...args) => { await patch(...args); mutate(f.record); };
    const result = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
    assert.equal(result.reserved, false);
    assert.equal(f.patches(), 1);
  }
});
test('simultaneous reservations cannot both win ETag compare-and-set', async () => {
  const f = fixture();
  const reserve = createAtomicApprovalReservation({ store: f.store, now: () => now });
  const results = await Promise.all([reserve(context), reserve(context)]);
  assert.equal(results.filter(x => x.reserved).length, 1);
  assert.equal(f.patches(), 1);
});
test('invalid approval identifier and missing store fail closed', async () => {
  assert.equal((await createAtomicApprovalReservation()({ ...context })).reserved, false);
  const f = fixture();
  assert.equal((await createAtomicApprovalReservation({ store: f.store, now: () => now })({ ...context, approvalId: '*' })).reserved, false);
  assert.equal(f.patches(), 0);
});
