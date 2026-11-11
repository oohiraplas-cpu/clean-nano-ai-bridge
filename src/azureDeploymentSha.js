'use strict';
// Pure comparator for independently sourced Azure deployment Git SHA.
// Caller-supplied metadata is never proof of running code or effective RBAC.
const SHA = /^[0-9a-f]{40}$/i;
const RESOURCE = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge$/i;
function compareDeploymentSha({ resourceId, azureSha, githubHeadSha, source, independentlyVerified } = {}) {
  if (!RESOURCE.test(resourceId || '') || !SHA.test(azureSha || '') ||
      !SHA.test(githubHeadSha || '') || independentlyVerified !== true ||
      source !== 'azure_deployment_provenance_verified') {
    return Object.freeze({ status: 'blocked', reason: 'independent_deployment_provenance_missing',
      shaMatched: false, deploymentShaVerified: false });
  }
  const shaMatched = azureSha.toLowerCase() === githubHeadSha.toLowerCase();
  // A caller-provided provenance flag cannot establish independently deployed code.
  // Match is only a candidate until the Azure-side trust boundary is implemented.
  return Object.freeze({ status: 'observed_not_verified',
    reason: shaMatched ? 'azure_provenance_adapter_not_connected' : 'sha_mismatch',
    shaMatched: false, candidateShaMatch: shaMatched, deploymentShaVerified: false });
}
module.exports = { compareDeploymentSha };
