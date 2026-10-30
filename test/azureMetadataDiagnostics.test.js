'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('../scripts/check-azure-metadata-only');
const { createAzureMetadataReader } = require('../src/azureMetadataReader');
const { sanitizeMetadataFailures } = require('../src/azureMetadataFailures');
const app = { name: 'clean-nano-ai-bridge', resourceGroup: 'rg',
  id: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/clean-nano-ai-bridge' };
const identity = { type: 'SystemAssigned', principalId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const secret = 'secret-canary-response-body';
function runner({ target = [app], identityResult = identity, deployments = [], failAt, error, raw } = {}) {
  return (command, args, options) => {
    assert.equal(command, 'az');
    assert.equal(options.timeout, 20000);
    const stage = args[1] === 'list' ? 'target_lookup' : args[1] === 'identity' ? 'identity_lookup' : 'deployment_history';
    if (stage === failAt) {
      if (raw !== undefined) return raw;
      throw error;
    }
    return JSON.stringify(stage === 'target_lookup' ? target : stage === 'identity_lookup' ? identityResult : deployments);
  };
}
async function read(runCli) {
  return createAzureMetadataReader({ collectMetadata: () => collect({ runCli }) }).readDeploymentMetadata();
}
for (const [label, error, raw, reason] of [
  ['missing CLI', Object.assign(new Error(secret), { code: 'ENOENT', stderr: secret }), undefined, 'cli_missing'],
  ['timeout', { code: 'ETIMEDOUT', status: null, stderr: secret }, undefined, 'timeout'],
  ['CLI exit', { status: 1, message: secret, stderr: secret }, undefined, 'cli_exit_nonzero'],
  ['unknown execution failure', { code: 'EACCES', message: secret }, undefined, 'cli_execution_failed'],
  ['invalid JSON', null, secret, 'malformed_json']
]) {
  for (const stage of ['target_lookup', 'identity_lookup', 'deployment_history']) {
    test(`Azure metadata diagnostics: ${label} at ${stage}`, async () => {
      const result = await read(runner({ failAt: stage, error, raw }));
      assert.deepEqual(result.metadataFailures, [{ stage, reason }]);
      assert.equal(result.resourceIdMatched, stage !== 'target_lookup');
      if (stage !== 'identity_lookup') assert.equal(result.status, 'blocked');
      assert.equal(result.diagnostic.status, 'blocked');
      assert.equal(JSON.stringify(result).includes(secret), false);
    });
  }
}
for (const [label, target, reason] of [
  ['object instead of list', {}, 'invalid_response'],
  ['no target', [], 'target_not_unique'],
  ['ambiguous target', [app, app], 'target_not_unique'],
  ['null target', [null], 'resource_id_mismatch'],
  ['wrong resource', [{ ...app, id: app.id + '-other' }], 'resource_id_mismatch'],
  ['mismatched CLI name', [{ ...app, name: 'other' }], 'resource_id_mismatch'],
  ['mismatched resource group', [{ ...app, resourceGroup: 'other' }], 'resource_id_mismatch']
]) {
  test(`Azure metadata diagnostics: ${label} blocks target`, async () => {
    const result = await read(runner({ target }));
    assert.equal(result.status, 'blocked');
    assert.equal(result.resourceIdMatched, false);
    assert.deepEqual(result.metadataFailures, [{ stage: 'target_lookup', reason }]);
  });
}
test('Azure metadata diagnostics: empty history is observed, not independent SHA proof', async () => {
  const observed = collect({ runCli: runner() });
  assert.equal(observed.deploymentMetadataAccessible, true);
  assert.equal(observed.deploymentShaMatched, false);
  assert.equal(observed.effectiveRbacVerified, false);
  assert.equal(observed.pacRuntimeVerified, false);
  const result = await read(runner());
  assert.equal(result.resourceIdMatched, true);
  assert.deepEqual(result.deploymentEntries, []);
  assert.deepEqual(result.metadataFailures, []);
  assert.equal(result.diagnostic.checks.githubShaMatch, 'unconfirmed');
});
test('Azure metadata diagnostics: invalid history cannot become an empty successful observation', async () => {
  for (const deployments of [null, {}, [null], [[]]]) {
    const result = await read(runner({ deployments }));
    assert.equal(result.status, 'blocked');
    assert.equal(result.resourceIdMatched, true);
    assert.deepEqual(result.deploymentEntries, []);
    assert.deepEqual(result.metadataFailures, [{ stage: 'deployment_history', reason: 'invalid_response' }]);
  }
});
test('Azure metadata diagnostics: missing identity is explicit while deployment observation survives', async () => {
  const result = await read(runner({ identityResult: null }));
  assert.equal(result.resourceIdMatched, true);
  assert.deepEqual(result.metadataFailures, [{ stage: 'identity_lookup', reason: 'identity_unverified' }]);
  assert.equal(result.diagnostic.status, 'blocked');
});
test('Azure metadata diagnostics: reader drops unknown labels and secret fields', async () => {
  const supplied = [{ stage: 'deployment_history', reason: 'timeout', stderr: secret },
    { stage: secret, reason: 'timeout' }, { stage: 'target_lookup', reason: secret }, null];
  assert.deepEqual(sanitizeMetadataFailures(supplied), [{ stage: 'deployment_history', reason: 'timeout' }]);
  assert.deepEqual(sanitizeMetadataFailures({ stage: secret }), []);
  assert.equal(sanitizeMetadataFailures(Array(100).fill(supplied[0])).length, 4);
  const result = await createAzureMetadataReader({ collectMetadata: () => ({ resourceIdMatched: true,
    deploymentMetadataAccessible: false, metadataFailures: supplied, secret }) }).readDeploymentMetadata();
  assert.equal(result.status, 'blocked');
  assert.equal(JSON.stringify(result).includes(secret), false);
});
test('Azure metadata diagnostics: unexpected collector exception is sanitized', async () => {
  for (const error of [new Error(secret), null, secret]) {
    const result = await createAzureMetadataReader({ collectMetadata: () => { throw error; } }).readDeploymentMetadata();
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.metadataFailures, [{ stage: 'metadata_reader', reason: 'collector_failed' }]);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});
