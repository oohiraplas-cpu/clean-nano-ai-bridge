const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { collectRuntimeEvidence } = require('../src/azureRuntimeEvidence');
const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-production-bridge.js'), 'utf8');

test('independent Azure deployment metadata is used, never GitHub SHA as deployed SHA', () => {
  assert.match(source, /azureDeploymentSha = report\.azure\.deployments/);
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
