const test = require('node:test');
const assert = require('node:assert/strict');
const { runBounded } = require('../src/cnaiBoundedRunner');

test('bounded runner stops on missing adapter and never spins', async () => {
  const worker = {
    status: async () => ({ status: 'READY', index: 0 }),
    verifyAndAdvance: async () => { throw new Error('must not advance'); },
    recordFailure: async () => { throw new Error('must not recover'); }
  };
  const result = await runBounded({
    worker, id: 'job1', authority: {
      targetLocked: true, sourceObservationComplete: true
    }, adapters: {}, maxSteps: 9
  });
  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.equal(result.iterations, 1);
});

test('bounded runner rejects unbounded step counts', async () => {
  await assert.rejects(() => runBounded({ maxSteps: 100 }), /maxSteps/);
});
