'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAtomicApprovalReservation, createApprovalRecheck } = require('../src/atomicApprovalReservation');
const { canonicalDiffHash } = require('../src/approvalScopeContractDraft');

function fixture({ conflict = false } = {}) {
  const now = Date.parse('2026-10-13T10:00:00Z');
  const context = { approvalId: '1', requestId: 'r', operation: 'save',
    targetSha: 'a'.repeat(40), appId: 'app-1', environmentId: 'env-1',
    runtimeCommitSha: 'c'.repeat(40), sourceSha: 'a'.repeat(40), params: {} };
  context.changeHash = canonicalDiffHash({ ...context });
  const record = { requestId: 'r', tool: 'save', targetId: 'app-1', environmentId: 'env-1',
    commitSha: context.runtimeCommitSha, diffHash: context.changeHash, approverId: 'human-1',
    approvedAt: '2026-10-13T09:00:00Z', expiresAt: '2026-10-13T11:00:00Z',
    status: '承認', revoked: false, executionId: '', executionStatus: '' };
  let version = 1, writes = 0;
  const store = {
    assertConfigured() {},
    async read() { return { record: structuredClone(record), etag: '"v' + version + '"',
      actor: { user: { id: version === 1 ? 'human-1' : 'service-1' } } }; },
    async verifyHuman(snapshot) { return snapshot.actor?.user?.id === 'human-1' && snapshot.record.approverId === 'human-1'; },
    async patch(id, etag, values) {
      if (conflict || etag !== '"v' + version + '"') throw new Error('etag_conflict');
      Object.assign(record, values); version++; writes++;
    }
  };
  return { store, context, now, getWrites: () => writes };
}

test('parallel reservations consume one approval at most once', async () => {
  const f = fixture();
  const reserve = createAtomicApprovalReservation({ store: f.store, now: () => f.now });
  const results = await Promise.all([reserve(f.context), reserve(f.context)]);
  assert.equal(results.filter(x => x.reserved).length, 1);
  assert.equal(f.getWrites(), 1);
});

test('ETag conflict fails closed without retry', async () => {
  const f = fixture({ conflict: true });
  const reserve = createAtomicApprovalReservation({ store: f.store, now: () => f.now });
  const result = await reserve(f.context);
  assert.equal(result.reserved, false);
  assert.equal(f.getWrites(), 0);
});

test('final recheck consumes receipt once and rejects replay', async () => {
  const f = fixture();
  const reserve = createAtomicApprovalReservation({ store: f.store, now: () => f.now });
  const recheck = createApprovalRecheck({ store: f.store, now: () => f.now });
  const result = await reserve(f.context);
  assert.equal(result.reserved, true);
  const scope = { ...f.context, executionId: result.executionId };
  assert.equal(await recheck(scope), true);
  assert.equal(await recheck(scope), false);
});

test('scope binds operation, runtime SHA, source SHA and canonical change hash', async () => {
  for (const delta of [{ operation: 'publish' }, { targetSha: 'c'.repeat(40) },
    { appId: 'other' }, { changeHash: 'd'.repeat(64) },
    { runtimeCommitSha: 'd'.repeat(40) }, { sourceSha: 'd'.repeat(40) }]) {
    const f = fixture();
    const reserve = createAtomicApprovalReservation({ store: f.store, now: () => f.now });
    assert.equal((await reserve({ ...f.context, ...delta })).reserved, false);
    assert.equal(f.getWrites(), 0);
  }
});

test('legacy approval without separate SHA domains fails before any PATCH', async () => {
  const f = fixture();
  const reserve = createAtomicApprovalReservation({ store: f.store, now: () => f.now });
  const { runtimeCommitSha, sourceSha, params, ...legacy } = f.context;
  assert.equal((await reserve(legacy)).reserved, false);
  assert.equal(f.getWrites(), 0);
});
test('parallel final rechecks authorize at most once', async () => {
  const f = fixture();
  const reserve = createAtomicApprovalReservation({ store: f.store, now: () => f.now });
  const recheck = createApprovalRecheck({ store: f.store, now: () => f.now });
  const result = await reserve(f.context);
  assert.equal(result.reserved, true);
  const scope = { ...f.context, executionId: result.executionId };
  const decisions = await Promise.all([recheck(scope), recheck(scope)]);
  assert.equal(decisions.filter(Boolean).length, 1);
});
