'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyBeforeMutation, verifyAfterMutation } = require('../src/p0ExecutionEvidence');
const sha = 'a'.repeat(40);
const base = { operation: 'publish', targetSha: sha, observedSha: sha, requestId: 'req1', actorId: 'actor', backupVerified: true, testsPassed: true, expected: { changeHash: 'b'.repeat(64), environmentId: 'env', appId: 'app' } };
const ledger = { configured: true, async check({ stepIndex }) { return { approved: true, approver: 'reviewer' + stepIndex, bindingVerified: true }; } };
test('two ledger checks and independently verified binding pass preflight', async () => assert.equal((await verifyBeforeMutation({ ...base, ledger })).allowed, true));
test('missing ledger blocks', async () => assert.equal((await verifyBeforeMutation(base)).reason, 'ledger_not_configured'));
test('missing immutable binding blocks even with two approvals', async () => assert.equal((await verifyBeforeMutation({ ...base, ledger, expected: {} })).reason, 'binding_evidence_missing'));
test('self approval blocks', async () => assert.equal((await verifyBeforeMutation({ ...base, ledger: { configured: true, check: async () => ({ approved: true, approver: 'actor' }) } })).allowed, false));
test('ledger read failure blocks', async () => assert.equal((await verifyBeforeMutation({ ...base, ledger: { configured: true, check: async () => { throw Error('offline'); } } })).reason, 'ledger_unreadable'));
test('HEAD mismatch blocks before ledger access', async () => assert.equal((await verifyBeforeMutation({ ...base, ledger, observedSha: 'b'.repeat(40) })).reason, 'head_mismatch'));
test('postflight requires independently confirmed operation', () => assert.equal(verifyAfterMutation({ operation: 'publish', expectedSha: sha, actualSha: sha, appCheckerCritical: 0, expectedVersion: 'v1', observedVersion: 'v1', operationConfirmed: false }).allowed, false));
test('postflight rejects stale version', () => assert.equal(verifyAfterMutation({ operation: 'publish', expectedSha: sha, actualSha: sha, appCheckerCritical: 0, expectedVersion: 'v1', observedVersion: 'v2', operationConfirmed: true }).allowed, false));
test('postflight accepts matching independently confirmed version', () => assert.equal(verifyAfterMutation({ operation: 'publish', expectedSha: sha, actualSha: sha, appCheckerCritical: 0, expectedVersion: 'v1', observedVersion: 'v1', operationConfirmed: true }).allowed, true));

test('caller-supplied boolean cannot bypass ledger binding', async () => assert.equal((await verifyBeforeMutation({ ...base, ledger: { configured: true, check: async () => ({ approved: true, approver: 'reviewer' }) }, expected: { ...base.expected, ledgerBindingVerified: true } })).reason, 'ledger_binding_unverified'));

test('change SHA-256 is distinct from a Git commit/blob SHA', async () => {
  assert.equal((await verifyBeforeMutation({ ...base, ledger })).allowed, true);
  assert.equal((await verifyBeforeMutation({ ...base, ledger, expected: { ...base.expected, changeHash: sha } })).reason, 'binding_evidence_missing');
});
test('the same SHA-256 decision passes evidence and atomic reservation contracts', async () => {
  const { createAtomicApprovalReservation, createApprovalRecheck } = require('../src/atomicApprovalReservation');
  const now = Date.now();
  const context = { approvalId: '7', requestId: base.requestId, operation: 'publish', targetSha: sha,
    appId: 'app', environmentId: 'env', changeHash: base.expected.changeHash };
  const record = { requestId: context.requestId, tool: 'publish', targetId: 'app', environmentId: 'env', commitSha: sha,
    diffHash: context.changeHash, approverId: 'human', approvedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(), revoked: false, status: '承認' };
  let etag = 1;
  const store = { assertConfigured() {}, verifyHuman: async () => true,
    read: async () => ({ etag: String(etag), record: { ...record } }),
    patch: async (id, expected, patch) => { assert.equal(expected, String(etag)); Object.assign(record, patch); etag++; } };
  assert.equal((await verifyBeforeMutation({ ...base, ledger })).allowed, true);
  const receipt = await createAtomicApprovalReservation({ store })(context);
  assert.equal(receipt.reserved, true);
  assert.equal(await createApprovalRecheck({ store })({ ...receipt, ...context }), true);
});
