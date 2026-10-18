const test = require('node:test');
const assert = require('node:assert/strict');
const { runIteration } = require('../src/cnaiIterationRunner');

const authority = { targetLocked: true, sourceObservationComplete: true };
function worker() {
  const state = { status: 'READY', index: 0, history: [] };
  return {
    status: async () => state,
    verifyAndAdvance: async () => ({
      state: { status: 'READY' }, nextStep: 'CI_SUCCESS'
    }),
    recordFailure: async (_, failure) => ({ status: 'BLOCKED', reason: failure.code })
  };
}

test('verified adapter advances checkpoint', async () => {
  const result = await runIteration({
    worker: worker(), id: 'job1', authority,
    adapters: { PR_COMPLETE: async () => ({ success: true, evidenceId: 'pr-108' }) }
  });
  assert.equal(result.nextStep, 'CI_SUCCESS');
});

test('missing adapter does not advance', async () => {
  const result = await runIteration({ worker: worker(), id: 'job1', authority, adapters: {} });
  assert.equal(result.status, 'NOT_CONFIGURED');
});

test('adapter failure passes to recovery planner', async () => {
  const result = await runIteration({
    worker: worker(), id: 'job1', authority,
    adapters: { PR_COMPLETE: async () => { throw new Error('timeout'); } },
    classifyError: () => ({ code: 'TRANSIENT_NETWORK', signature: 'timeout' })
  });
  assert.equal(result.recovery.reason, 'TRANSIENT_NETWORK');
});

test('unverified output cannot advance', async () => {
  const result = await runIteration({
    worker: worker(), id: 'job1', authority,
    adapters: { PR_COMPLETE: async () => ({ success: true }) }
  });
  assert.equal(result.status, 'BLOCKED');
});
