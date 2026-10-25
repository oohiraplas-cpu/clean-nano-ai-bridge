'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAzureMetadataReader } = require('../src/azureMetadataReader');

for (const reason of [
  'azure_cli_or_auth_unavailable',
  'azure_target_unverified',
  'azure_resource_id_unverified',
  'azure_deployment_history_unavailable'
]) {
  test('Azure READ preserves safe failure code: ' + reason, async () => {
    const reader = createAzureMetadataReader({ collectMetadata: () => ({
      status: 'blocked', reason, resourceIdMatched: false,
      deploymentMetadataAccessible: false, deploymentEntries: []
    }) });
    const result = await reader.readDeploymentMetadata();
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, reason);
    assert.deepEqual(result.deploymentEntries, []);
  });
}
test('Azure READ never echoes unexpected errors', async () => {
  const reader = createAzureMetadataReader({ collectMetadata: () => ({
    reason: 'secret-token-123', resourceIdMatched: false,
    deploymentMetadataAccessible: false, deploymentEntries: []
  }) });
  const result = await reader.readDeploymentMetadata();
  assert.equal(result.reason, 'azure_metadata_unverified');
  assert.equal(JSON.stringify(result).includes('secret-token-123'), false);
});
test('Azure CLI exception remains fail closed', async () => {
  const reader = createAzureMetadataReader({ collectMetadata: () => { throw Error('sensitive credentials'); } });
  const result = await reader.readDeploymentMetadata();
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'azure_metadata_unavailable');
  assert.equal(JSON.stringify(result).includes('sensitive credentials'), false);
});
