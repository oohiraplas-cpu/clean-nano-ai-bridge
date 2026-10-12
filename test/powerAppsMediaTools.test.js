'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPowerAppsMediaTools, OPS } = require('../src/powerAppsMediaTools');

test('all three media operations are exposed', () => {
  assert.deepEqual(OPS, ['list_powerapps_media_assets', 'get_powerapps_media_asset', 'export_powerapps_asset']);
});
test('unconfigured media tools fail closed', async () => {
  const exec = createPowerAppsMediaTools({ appId: 'app', environmentId: 'env' });
  for (const op of OPS) {
    const result = await exec(op, { assetId: 'logo.png' });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.sideEffects, false);
  }
});
test('trusted read-only adapter receives bound target and asset id', async () => {
  const calls = [];
  const adapter = Object.fromEntries(OPS.map(op => [op, async params => {
    calls.push([op, params]); return { success: true, data: { name: 'logo.png' } };
  }]));
  const exec = createPowerAppsMediaTools({ appId: 'app', environmentId: 'env', adapter });
  assert.equal((await exec('list_powerapps_media_assets')).status, 'VERIFIED');
  assert.equal((await exec('get_powerapps_media_asset', { assetId: 'logo.png' })).status, 'VERIFIED');
  assert.equal((await exec('export_powerapps_asset', { assetId: 'logo.png' })).status, 'VERIFIED');
  assert.deepEqual(calls[0][1], { appId: 'app', environmentId: 'env' });
  assert.deepEqual(calls[2][1], { appId: 'app', environmentId: 'env', assetId: 'logo.png' });
});
test('invalid media identifiers and adapter errors fail closed', async () => {
  let calls = 0;
  const adapter = Object.fromEntries(OPS.map(op => [op, async () => { calls++; throw Error('unavailable'); }]));
  const exec = createPowerAppsMediaTools({ appId: 'app', environmentId: 'env', adapter });
  assert.equal((await exec('get_powerapps_media_asset', { assetId: '../secret' })).status, 'BLOCKED');
  assert.equal(calls, 0);
  assert.equal((await exec('export_powerapps_asset', { assetId: 'logo.png' })).reason, 'media_read_failed');
});
