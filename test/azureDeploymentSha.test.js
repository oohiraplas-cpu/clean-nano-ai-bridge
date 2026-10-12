const test = require('node:test');
const assert = require('node:assert/strict');
const { compareDeploymentSha } = require('../src/azureDeploymentSha');
const resourceId = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/clean-nano-ai-bridge';
const githubHeadSha = 'a'.repeat(40);
test('Azure SHA requires independent provenance, not deployment IDs or GitHub self-assertion', () => {
  for (const input of [
    { azureSha: githubHeadSha, githubHeadSha },
    { azureSha: githubHeadSha, githubHeadSha, independentlyVerified: true },
    { azureSha: 'deployment-123', githubHeadSha, independentlyVerified: true, source: 'azure_deployment_provenance_verified' },
    { azureSha: githubHeadSha, githubHeadSha, independentlyVerified: true, source: 'github' }
  ]) {
    const result = compareDeploymentSha({ resourceId, ...input });
    assert.equal(result.status, 'blocked');
    assert.equal(result.shaMatched, false);
  }
});
test('forged independent-provenance flag never marks deployment verified', () => {
  const result = compareDeploymentSha({ resourceId, azureSha: githubHeadSha, githubHeadSha,
    independentlyVerified: true, source: 'azure_deployment_provenance_verified' });
  assert.equal(result.status, 'observed_not_verified');
  assert.equal(result.candidateShaMatch, true);
  assert.equal(result.deploymentShaVerified, false);
  assert.equal(result.shaMatched, false);
});
test('SHA mismatch and wrong resource fail closed', () => {
  const mismatch = compareDeploymentSha({ resourceId, azureSha: 'b'.repeat(40), githubHeadSha,
    independentlyVerified: true, source: 'azure_deployment_provenance_verified' });
  assert.equal(mismatch.candidateShaMatch, false);
  assert.equal(mismatch.shaMatched, false);
  assert.equal(compareDeploymentSha({ resourceId: resourceId.replace('clean-nano-ai-bridge', 'other'),
    azureSha: githubHeadSha, githubHeadSha }).status, 'blocked');
});
