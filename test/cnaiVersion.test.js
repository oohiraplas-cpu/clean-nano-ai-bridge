const test = require('node:test');
const assert = require('node:assert/strict');
const { getCnaiVersion } = require('../src/cnaiVersion');

test('CNAI version is separately tracked from bridge package', () => {
  const info = getCnaiVersion();
  assert.equal(info.version, '6.0.0-beta.1');
  assert.equal(info.bridgePackageVersionUnchanged, true);
});

test('unimplemented execution and production deployment are never reported ready', () => {
  const info = getCnaiVersion();
  assert.equal(info.productionReady, false);
  assert.equal(info.capabilities.autonomousExecutionWorker, 'not-implemented');
  assert.equal(info.capabilities.productionRelease, 'not-deployed');
});
