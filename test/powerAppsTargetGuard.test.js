const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerAppsStore } = require('../src/powerAppsStore');
const { CN_AI_TARGET } = require('../src/config');

const target = {
  appId: CN_AI_TARGET.appId,
  environmentId: CN_AI_TARGET.environmentId,
  orgUrl: CN_AI_TARGET.orgUrl,
  solutionUniqueName: CN_AI_TARGET.solutionUniqueName,
  githubRoot: CN_AI_TARGET.githubRoot
};

test('all direct Power Apps write operations fail closed before network access', async () => {
  let networkCalls = 0;
  const store = new PowerAppsStore({
    ...target,
    appId: 'wrong-app',
    fetchImpl: async () => { networkCalls++; throw new Error('network must not be reached'); }
  });
  await assert.rejects(store.updateApp({ description: 'change' }), /CN_AI target mismatch/);
  await assert.rejects(store.saveApp(), /CN_AI target mismatch/);
  await assert.rejects(store.publishApp(), /CN_AI target mismatch/);
  assert.equal(networkCalls, 0);
});

test('missing target fields prevent all direct writes', async () => {
  const store = new PowerAppsStore({ ...target, githubRoot: '' });
  await assert.rejects(store.updateApp({ description: 'change' }), /CN_AI target mismatch/);
  await assert.rejects(store.saveApp(), /CN_AI target mismatch/);
  await assert.rejects(store.publishApp(), /CN_AI target mismatch/);
});
