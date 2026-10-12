const test = require('node:test');
const assert = require('node:assert/strict');
const { collectRuntimeEvidence } = require('../src/azureRuntimeEvidence');
const validMap = JSON.stringify({ 'App.pa.yaml': 'Src/App.pa.yaml' });
const settings = { POWERAPPS_RUNTIME_AUTH_MODE: 'managedIdentity', POWERAPPS_RUNTIME_SOURCE_MAP: validMap };

test('configuration alone never proves PAC authentication or runtime source', () => {
  const result = collectRuntimeEvidence({ settings });
  assert.equal(result.managedIdentityModeConfigured, true);
  assert.equal(result.sourceMapSchemaValid, true);
  assert.equal(result.pacProfileVerified, false);
  assert.equal(result.sourceMapVerified, false);
  assert.equal(result.effectiveRbacVerified, false);
});
test('saved-msapp provenance and digest required', () => {
  const probe = { trustedAdapterVerified: true, status: 'ok', source: 'power-apps-saved-msapp', runtimeHash: 'a'.repeat(64), appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e', expectedAppId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e', environment: 'env-1', expectedEnvironment: 'env-1' };
  assert.equal(collectRuntimeEvidence({ settings, pacProbe: probe }).sourceMapVerified, true);
  assert.equal(collectRuntimeEvidence({ settings, pacProbe: { ...probe, source: 'github' } }).pacProfileVerified, false);
  assert.equal(collectRuntimeEvidence({ settings, pacProbe: { ...probe, trustedAdapterVerified: false } }).pacProfileVerified, false);
  assert.equal(collectRuntimeEvidence({ settings, pacProbe: { ...probe, expectedEnvironment: 'other' } }).sourceMapVerified, false);
});
test('independent deployment SHA must match', () => {
  const sha = 'b'.repeat(40);
  assert.equal(collectRuntimeEvidence({ deployment: { azureDeployedSha: sha, expectedSha: sha } }).deploymentShaMatched, false);
  assert.equal(collectRuntimeEvidence({ deployment: { azureDeployedSha: sha, expectedSha: sha, independentAzureSource: true } }).deploymentShaMatched, true);
});
test('invalid source map never leaks its content', () => {
  const result = collectRuntimeEvidence({ settings: { POWERAPPS_RUNTIME_SOURCE_MAP: '{"secret":"password"}' } });
  assert.equal(result.sourceMapSchemaValid, false);
  assert.equal(JSON.stringify(result).includes('password'), false);
});
