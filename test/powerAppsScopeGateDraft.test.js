'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPowerAppsMutationGate } = require('../src/powerAppsMutationGate');
const { canonicalDiffHash } = require('../src/approvalScopeContractDraft');

function setup() {
  const input = { operation: 'save', approvalId: '1', requestId: 'req', appId: 'app',
    environmentId: 'env', targetSha: 'b'.repeat(40), sourceSha: 'b'.repeat(40),
    runtimeCommitSha: 'a'.repeat(40), params: { targetVersion: 1 } };
  input.changeHash = canonicalDiffHash(input);
  let reservations = 0, mutations = 0, rechecks = 0;
  const gate = createPowerAppsMutationGate({
    async readRuntimeSha() { return input.runtimeCommitSha; },
    async verifyTarget() { return true; },
    async verifyBackup() { return true; },
    async readCurrentSha() { return input.sourceSha; },
    async reserveApproval(scope) {
      reservations++;
      assert.equal(scope.runtimeCommitSha, input.runtimeCommitSha);
      assert.equal(scope.sourceSha, input.sourceSha);
      assert.deepEqual(scope.params, input.params);
      return { reserved: true, singleUseVerified: true, approvalActiveVerified: true,
        executionId: 'exec', targetSha: scope.targetSha, requestId: scope.requestId,
        operation: scope.operation };
    },
    async recheckApproval(scope) { rechecks++; return scope.executionId === 'exec'; },
    async verifyPostcondition() { return true; }
  });
  return { input, gate, counts: () => ({ reservations, mutations, rechecks }),
    mutate: async () => { mutations++; return { success: true }; } };
}
test('separate SHA domains and canonical hash reach reservation and final recheck', async () => {
  const f = setup();
  const result = await f.gate({ ...f.input, mutate: f.mutate });
  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(f.counts(), { reservations: 1, mutations: 1, rechecks: 1 });
});
test('legacy request, forged hash, altered operation and missing params block before mutation', async () => {
  for (const delta of [{ runtimeCommitSha: undefined }, { sourceSha: undefined },
    { params: undefined }, { changeHash: 'c'.repeat(64) }, { operation: 'publish' },
    { sourceSha: 'd'.repeat(40) }]) {
    const f = setup();
    const result = await f.gate({ ...f.input, ...delta, mutate: f.mutate });
    assert.equal(result.status, 'BLOCKED');
    assert.deepEqual(f.counts(), { reservations: 0, mutations: 0, rechecks: 0 });
  }
});

test('missing server runtime SHA attestation blocks even otherwise valid approval', async () => {
  const f = setup();
  // The gate must fail closed when no trusted readRuntimeSha dependency exists.
  const unconfigured = createPowerAppsMutationGate({
    reserveApproval: async () => { throw Error('must not reserve'); },
    recheckApproval: async () => true,
    readCurrentSha: async () => f.input.sourceSha,
    verifyTarget: async () => true,
    verifyBackup: async () => true,
    verifyPostcondition: async () => true
  });
  const result = await unconfigured({ ...f.input, mutate: f.mutate });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'runtime_sha_unverified');
  assert.equal(f.counts().mutations, 0);
});
