'use strict';
// Candidate provenance from Azure control-plane deployment metadata only.
// Never equate GitHub workflow success or an opaque deployment ID with running code.
const SHA = /^[0-9a-f]{40}$/i;
const RESOURCE = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge$/i;
function assessDeploymentProvenance({ resourceId, azureRecord, githubWorkflow, githubHeadSha } = {}) {
  const blocked = reason => Object.freeze({ status: 'blocked', reason,
    candidateShaMatch: false, deploymentShaVerified: false, runningCodeVerified: false });
  if (!RESOURCE.test(resourceId || '') || !SHA.test(githubHeadSha || ''))
    return blocked('target_or_github_sha_unverified');
  if (!azureRecord || azureRecord.active !== true || !SHA.test(azureRecord.commitSha || '') ||
      azureRecord.resourceId !== resourceId)
    return blocked('independent_azure_commit_unavailable');
  if (!githubWorkflow || githubWorkflow.conclusion !== 'success' ||
      !SHA.test(githubWorkflow.headSha || '') || githubWorkflow.headSha.toLowerCase() !== githubHeadSha.toLowerCase())
    return blocked('github_workflow_provenance_unverified');
  const candidateShaMatch = azureRecord.commitSha.toLowerCase() === githubHeadSha.toLowerCase();
  return Object.freeze({ status: 'observed_not_verified',
    reason: candidateShaMatch ? 'running_code_attestation_missing' : 'sha_mismatch',
    candidateShaMatch, deploymentShaVerified: false, runningCodeVerified: false });
}
module.exports = { assessDeploymentProvenance };
