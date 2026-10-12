'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAtomicApprovalReservation, createApprovalRecheck } = require('../src/atomicApprovalReservation');
const now = Date.parse('2026-10-13T00:00:00Z');
const sha = 'a'.repeat(40), hash = 'b'.repeat(64);
const context = { approvalId: '7', requestId: 'req-1', operation: 'deploy', targetSha: sha, appId: 'app-1', environmentId: 'env-1', changeHash: hash };
function fixture(overrides = {}) {
  const record = { requestId: 'req-1', tool: 'deploy', targetId: 'app-1', environmentId: 'env-1',
    commitSha: sha, diffHash: hash, approvedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(), approverId: 'human-approver', status: '承認', revoked: false };
  let version = 1, patches = 0;
  const store = {
    assertConfigured() {},
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

test('fresh recheck denies revoked, expired or replaced reservation', async () => {
  for (const mutate of [
    record => { record.revoked = true; },
    record => { record.expiresAt = new Date(now - 1).toISOString(); },
    record => { record.executionId = 'other-execution'; },
    record => { record.targetId = 'other-app'; }
  ]) {
    const f = fixture();
    const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
    assert.equal(reserved.reserved, true);
    mutate(f.record);
    assert.equal(await createApprovalRecheck({ store: f.store, now: () => now })({ ...reserved, appId: context.appId, environmentId: context.environmentId, changeHash: context.changeHash }), false);
  }
});
test('service-side reservation changes lastModifiedBy: human recheck fails closed', async () => {
  // SharePoint lastModifiedBy may change to the Bridge service identity after PATCH.
  // Do not mistake the service actor for the original human approver.
  const f = fixture();
  let actor = 'human-approver';
  const patch = f.store.patch;
  f.store.patch = async (...args) => { await patch(...args); actor = 'bridge-service'; };
  f.store.verifyHuman = async () => actor === 'human-approver';
  const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  assert.equal(reserved.reserved, false);
  const valid = await createApprovalRecheck({ store: f.store, now: () => now })({
    ...reserved, appId: context.appId, environmentId: context.environmentId, changeHash: context.changeHash
  });
  assert.equal(valid, false, 'service write must not be accepted as human approval');
});

test('fresh recheck accepts only the exact reserved approval', async () => {
  const f = fixture();
  const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  assert.equal(await createApprovalRecheck({ store: f.store, now: () => now })({ ...reserved, appId: context.appId, environmentId: context.environmentId, changeHash: context.changeHash }), true);
});

test('unconfigured SharePoint store fails closed before reading or patching', async () => {
  const f = fixture(); let reads = 0;
  f.store.assertConfigured = () => { throw new Error('missing field map'); };
  f.store.read = async () => { reads++; throw new Error('should not read'); };
  const reserve = createAtomicApprovalReservation({ store: f.store, now: () => now });
  assert.equal((await reserve(context)).reserved, false);
  assert.equal(reads, 0);
  assert.equal(f.patches(), 0);
});

test('original Graph human identity survives service actor PATCH and is freshly checked', async () => {
  const f = fixture(); let actor = 'human-approver', enabled = true, checks = 0;
  const read = f.store.read, patch = f.store.patch;
  f.store.read = async () => ({ ...await read(), actor: { user: { id: actor } } });
  f.store.patch = async (...args) => { await patch(...args); actor = 'bridge-service'; };
  f.store.verifyHuman = async snapshot => {
    checks++;
    return enabled && snapshot.actor.user.id === snapshot.record.approverId;
  };
  const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  assert.equal(reserved.reserved, true);
  const input = { ...reserved, appId: context.appId, environmentId: context.environmentId, changeHash: context.changeHash };
  const recheck = createApprovalRecheck({ store: f.store, now: () => now });
  assert.equal(await recheck(input), true);
  assert.equal(checks, 3);
  enabled = false;
  assert.equal(await recheck(input), false);
});
test('decision identity and lifetime cannot change during reservation or recheck', async () => {
  for (const field of ['approverId', 'approvedAt', 'expiresAt']) {
    for (const duringPatch of [true, false]) {
      const f = fixture(), patch = f.store.patch;
      const mutate = () => { f.record[field] = field === 'approverId' ? 'other-human' : new Date(now + 30000).toISOString(); };
      if (duringPatch) f.store.patch = async (...args) => { await patch(...args); mutate(); };
      const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
      if (duringPatch) assert.equal(reserved.reserved, false);
      else {
        assert.equal(reserved.reserved, true); mutate();
        assert.equal(await createApprovalRecheck({ store: f.store, now: () => now })({ ...reserved, ...context }), false);
      }
    }
  }
});
test('caller cannot reconstruct an authenticated receipt on another store instance', async () => {
  const f = fixture();
  const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  assert.equal(await createApprovalRecheck({ store: { ...f.store }, now: () => now })({ ...reserved, ...context }), false);
});
test('ledger change during independent directory verification is denied', async () => {
  const f = fixture();
  const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  f.store.verifyHuman = async () => { f.record.revoked = true; return true; };
  assert.equal(await createApprovalRecheck({ store: f.store, now: () => now })({ ...reserved, ...context }), false);
});
test('unchanged or wildcard reservation ETag never yields a usable receipt', async () => {
  for (const etag of ['1', '*']) {
    const f = fixture(), read = f.store.read; let reads = 0;
    f.store.read = async () => { const snapshot = await read(); if (++reads > 1) snapshot.etag = etag; return snapshot; };
    assert.equal((await createAtomicApprovalReservation({ store: f.store, now: () => now })(context)).reserved, false);
  }
});

test('disabled or removed human is denied before the first recheck', async () => {
  const f = fixture();
  const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  let checks = 0;
  f.store.verifyHuman = async () => { checks++; return false; };
  assert.equal(await createApprovalRecheck({ store: f.store, now: () => now })({ ...reserved, ...context }), false);
  assert.equal(checks, 1);
});
test('concurrent final rechecks authorize at most one mutation', async () => {
  const f = fixture();
  const reserved = await createAtomicApprovalReservation({ store: f.store, now: () => now })(context);
  const recheck = createApprovalRecheck({ store: f.store, now: () => now });
  const input = { ...reserved, ...context };
  const results = await Promise.all([recheck(input), recheck(input)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await recheck(input), false);
});
