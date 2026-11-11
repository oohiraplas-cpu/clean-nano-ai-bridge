const test = require('node:test');
const assert = require('node:assert/strict');
const { assessDeploymentProvenance } = require('../src/azureDeploymentProvenance');
const resourceId = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/clean-nano-ai-bridge';
const sha = 'a'.repeat(40);
const azureRecord = { resourceId, active: true, commitSha: sha };
const githubWorkflow = { headSha: sha, conclusion: 'success' };
test('GitHub workflow success alone never proves Azure deployment', () => {
  const result = assessDeploymentProvenance({ resourceId, githubWorkflow, githubHeadSha: sha });
  assert.equal(result.status, 'blocked');
  assert.equal(result.runningCodeVerified, false);
});
test('opaque deployment ID cannot replace independent Azure commit', () => {
  const result = assessDeploymentProvenance({ resourceId, azureRecord: { resourceId, active: true, id: sha },
    githubWorkflow, githubHeadSha: sha });
  assert.equal(result.status, 'blocked');
});
test('matching independent Azure candidate never proves running code', () => {
  const result = assessDeploymentProvenance({ resourceId, azureRecord, githubWorkflow, githubHeadSha: sha });
  assert.equal(result.status, 'observed_not_verified');
  assert.equal(result.candidateShaMatch, true);
  assert.equal(result.deploymentShaVerified, false);
  assert.equal(result.runningCodeVerified, false);
});
test('mismatched GitHub workflow and Azure record fail closed', () => {
  assert.equal(assessDeploymentProvenance({ resourceId, azureRecord,
    githubWorkflow: { headSha: 'b'.repeat(40), conclusion: 'success' }, githubHeadSha: sha }).status, 'blocked');
  assert.equal(assessDeploymentProvenance({ resourceId, azureRecord: { ...azureRecord, commitSha: 'b'.repeat(40) },
    githubWorkflow, githubHeadSha: sha }).candidateShaMatch, false);
  assert.equal(assessDeploymentProvenance({ resourceId: resourceId.replace('clean-nano-ai-bridge', 'other'),
    azureRecord, githubWorkflow, githubHeadSha: sha }).status, 'blocked');
});
