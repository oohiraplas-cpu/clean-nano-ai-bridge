const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyAuthority, executeStep } = require('../src/cnaiBridgeExecutor');

const base = { targetLocked: true, sourceObservationComplete: true };

test('read-only verified adapter returns evidence', async () => {
  const result = await executeStep({
    step: 'CI_SUCCESS', authority: base,
    adapters: { CI_SUCCESS: async () => ({ success: true, evidenceId: 'run-568' }) }
  });
  assert.equal(result.status, 'VERIFIED');
});

test('mutation requires backup, rollback and server-side human approval', async () => {
  assert.equal(verifyAuthority('AZURE_DEPLOY', base).allowed, false);
  const complete = { ...base, humanAuthorizationVerified: true,
    backupVerified: true, rollbackAvailable: true };
  assert.equal(verifyAuthority('AZURE_DEPLOY', complete).allowed, true);
});

test('missing adapter does not simulate success', async () => {
  const result = await executeStep({ step: 'THREE_SCREENS', authority: base, adapters: {} });
  assert.equal(result.status, 'NOT_CONFIGURED');
});

test('unverified adapter result cannot advance', async () => {
  const result = await executeStep({
    step: 'READ_BACK', authority: base,
    adapters: { READ_BACK: async () => ({ success: true }) }
  });
  assert.equal(result.status, 'NEEDS_RECOVERY');
});

test('publishing is not a runnable adapter', () => {
  assert.equal(verifyAuthority('PUBLISH_APPROVAL', {
    ...base, humanAuthorizationVerified: true
  }).allowed, false);
});
