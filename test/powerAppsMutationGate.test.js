'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPowerAppsMutationGate } = require('../src/powerAppsMutationGate');
const scope = { operation: 'save', approvalId: '1', requestId: 'req-1',
  appId: 'app-1', environmentId: 'env-1', targetSha: 'a'.repeat(40),
  changeHash: 'b'.repeat(64) };
function fixture(overrides = {}) {
  const calls = [];
  const deps = {
    verifyTarget: async () => { calls.push('target'); return true; },
    verifyBackup: async () => { calls.push('backup'); return true; },
    readCurrentSha: async () => { calls.push('sha'); return scope.targetSha; },
    reserveApproval: async x => { calls.push('reserve'); return {
      reserved: true, singleUseVerified: true, approvalActiveVerified: true,
      executionId: 'execution-1', targetSha: x.targetSha, requestId: x.requestId, operation: x.operation }; },
    recheckApproval: async () => { calls.push('recheck'); return true; },
    verifyPostcondition: async () => { calls.push('post'); return true; },
    ...overrides
  };
  const mutate = async () => { calls.push('mutate'); return { success: true }; };
  return { calls, deps, mutate };
}
test('missing trusted dependencies fail closed without mutation', async () => {
  let mutated = false;
  const gate = createPowerAppsMutationGate();
  const result = await gate({ ...scope, mutate: async () => { mutated = true; } });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(mutated, false);
});
test('verified authorization sequence and postcondition', async () => {
  const f = fixture();
  const result = await createPowerAppsMutationGate(f.deps)({ ...scope, mutate: f.mutate });
  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(f.calls, ['target','backup','sha','reserve','sha','recheck','mutate','post']);
});
for (const [name, overrides, reason] of [
  ['independent target check', { verifyTarget: async () => false }, 'target_or_backup_unverified'],
  ['backup', { verifyBackup: async () => false }, 'target_or_backup_unverified'],
  ['ETag reservation', { reserveApproval: async () => ({ reserved: false }) }, 'approval_reservation_failed'],
  ['revoked approval', { recheckApproval: async () => false }, 'approval_revoked_or_unverified'],
  ['postcondition', { verifyPostcondition: async () => false }, 'postcondition_unverified']
]) test(name + ' fails closed', async () => {
  const f = fixture(overrides);
  const result = await createPowerAppsMutationGate(f.deps)({ ...scope, mutate: f.mutate });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, reason);
  if (name !== 'postcondition') assert.equal(f.calls.includes('mutate'), false);
});
test('SHA mismatch after reservation never mutates', async () => {
  let n = 0;
  const f = fixture({ readCurrentSha: async () => ++n === 1 ? scope.targetSha : 'c'.repeat(40) });
  const result = await createPowerAppsMutationGate(f.deps)({ ...scope, mutate: f.mutate });
  assert.equal(result.reason, 'sha_changed_after_reservation');
  assert.equal(f.calls.includes('mutate'), false);
});

test('failed postcondition requires human-approved recovery, never automatic retry', async () => {
  const f = fixture({ verifyPostcondition: async () => false });
  const result = await createPowerAppsMutationGate(f.deps)({ ...scope, mutate: f.mutate });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(f.calls.filter(x => x === 'mutate').length, 1);
});
test('uncertain mutation outcome requires recovery without replay', async () => {
  const f = fixture();
  const result = await createPowerAppsMutationGate(f.deps)({ ...scope, mutate: async () => {
    f.calls.push('mutate'); return { success: false };
  } });
  assert.equal(result.reason, 'mutation_failed_or_uncertain');
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(f.calls.filter(x => x === 'mutate').length, 1);
});

test('mutation exception requires manual recovery and never retries', async () => {
  const f = fixture();
  const result = await createPowerAppsMutationGate(f.deps)({ ...scope, mutate: async () => {
    f.calls.push('mutate'); throw new Error('network timeout after write');
  } });
  assert.equal(result.reason, 'mutation_outcome_unknown');
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(f.calls.filter(x => x === 'mutate').length, 1);
});
test('postcondition exception requires manual recovery and never retries', async () => {
  const f = fixture({ verifyPostcondition: async () => { throw new Error('read unavailable'); } });
  const result = await createPowerAppsMutationGate(f.deps)({ ...scope, mutate: f.mutate });
  assert.equal(result.reason, 'mutation_outcome_unknown');
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(f.calls.filter(x => x === 'mutate').length, 1);
});

test('atomic edit gate without a trusted SharePoint store fails closed', async () => {
  const { createAtomicPowerAppsMutationGate } = require('../src/powerAppsMutationGate');
  let mutated = false;
  const result = await createAtomicPowerAppsMutationGate()({ ...scope, operation: 'update',
    mutate: async () => { mutated = true; return { success: true }; } });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(mutated, false);
});
test('atomic edit gate rejects unverified human without mutation or ETag patch', async () => {
  const { createAtomicPowerAppsMutationGate } = require('../src/powerAppsMutationGate');
  const now = Date.now();
  let patches = 0, mutations = 0;
  const record = { requestId: scope.requestId, tool: 'update', targetId: scope.appId,
    environmentId: scope.environmentId, commitSha: scope.targetSha, diffHash: scope.changeHash,
    approverId: 'human-1', approvedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(), status: '承認', revoked: false };
  const store = { assertConfigured() {}, read: async () => ({ etag: '1', record }),
    patch: async () => { patches++; }, verifyHuman: async () => false };
  const gate = createAtomicPowerAppsMutationGate({ approvalStore: store,
    verifyTarget: async () => true, verifyBackup: async () => true,
    readCurrentSha: async () => scope.targetSha, verifyPostcondition: async () => true });
  const result = await gate({ ...scope, operation: 'update',
    mutate: async () => { mutations++; return { success: true }; } });
  assert.equal(result.reason, 'approval_reservation_failed');
  assert.equal(patches, 0);
  assert.equal(mutations, 0);
});
