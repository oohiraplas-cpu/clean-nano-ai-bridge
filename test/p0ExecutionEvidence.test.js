'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyBeforeMutation, verifyAfterMutation } = require('../src/p0ExecutionEvidence');
const sha = 'a'.repeat(40);
const base = { operation: 'publish', targetSha: sha, observedSha: sha, requestId: 'req1', actorId: 'actor', backupVerified: true, testsPassed: true, expected: { changeHash: sha, environmentId: 'env', appId: 'app' } };
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
