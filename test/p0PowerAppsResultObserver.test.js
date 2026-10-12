'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observePowerAppsResult } = require('../src/p0PowerAppsResultObserver');
const opts = { expectedAppId: 'app', expectedEnvironmentId: 'env', expectedVersion: 'v1' };
test('current version is not independent proof of publish', async () => {
  const result = await observePowerAppsResult({ ...opts, store: { getAppState: async () => ({ status:'ok', appId:'app', environmentId:'env', versionNumber:'v1' }) } });
  assert.equal(result.operationConfirmed, false);
  assert.equal(result.reason, 'independent_publish_or_save_proof_unavailable');
});
test('wrong environment fails closed', async () => {
  const result = await observePowerAppsResult({ ...opts, store: { getAppState: async () => ({ status:'ok', appId:'app', environmentId:'other', versionNumber:'v1' }) } });
  assert.equal(result.reason, 'app_target_mismatch');
});
test('read error fails closed', async () => {
  const result = await observePowerAppsResult({ ...opts, store: { getAppState: async () => { throw Error('unavailable'); } } });
  assert.equal(result.reason, 'app_state_unavailable');
});
