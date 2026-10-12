const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { collectRuntimeEvidence } = require('../src/azureRuntimeEvidence');
const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-production-bridge.js'), 'utf8');

test('independent Azure deployment metadata is used, never GitHub SHA as deployed SHA', () => {
  assert.ok(source.includes('activeDeployment.commitSha'));
  assert.match(source, /independentAzureSource: azureDeploymentSha !== null/);
  assert.doesNotMatch(source, /azureDeployedSha: process\.env\.GITHUB_SHA/);
});
test('missing independent deployment SHA fails closed', () => {
  const expectedSha = 'a'.repeat(40);
  assert.equal(collectRuntimeEvidence({ deployment: { expectedSha } }).deploymentShaMatched, false);
});
test('remote MCP source cannot assert trusted adapter provenance', () => {
  const probe = { status: 'ok', source: 'power-apps-saved-msapp', runtimeHash: 'b'.repeat(64) };
  assert.equal(collectRuntimeEvidence({ pacProbe: probe }).pacProfileVerified, false);
  assert.match(source, /const sourceProbe = null/);
});

test('opaque deployment ID cannot be interpreted as Git commit', () => {
  assert.ok(!source.includes('shaPattern.test(d.id'));
  assert.ok(source.includes('commitSha: typeof d.commitSha'));
});
test('trusted PAC evidence must match app and environment', () => {
  const appId = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
  const probe = { trustedAdapterVerified: true, status: 'ok', source: 'power-apps-saved-msapp',
    runtimeHash: 'a'.repeat(64), appId, expectedAppId: appId,
    environment: 'env-1', expectedEnvironment: 'env-1' };
  assert.equal(collectRuntimeEvidence({ pacProbe: probe }).pacProfileVerified, true);
  assert.equal(collectRuntimeEvidence({ pacProbe: { ...probe, expectedEnvironment: 'env-2' } }).pacProfileVerified, false);
});
