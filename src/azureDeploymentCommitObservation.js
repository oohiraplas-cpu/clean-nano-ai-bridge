'use strict';
// Explicit opt-in, read-only Azure deployment record observation.
// An Azure deployment record is NOT proof of the code currently running.
const { execFileSync } = require('node:child_process');
const RESOURCE = /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge$/i;
const SHA = /^[0-9a-f]{40}$/i;
function observeAzureDeploymentCommit({ resourceId, run = execFileSync } = {}) {
  const match = typeof resourceId === 'string' && RESOURCE.exec(resourceId);
  if (!match) return Object.freeze({ status: 'blocked', reason: 'target_unverified', runningCodeVerified: false });
  try {
    const raw = run('az', ['webapp', 'log', 'deployment', 'list',
      '--name', 'clean-nano-ai-bridge', '--resource-group', match[1],
      '--query', '[].{active:active,commitSha:commitSha,id:id}',
      '--only-show-errors', '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw Error('invalid_deployment_metadata');
    const active = rows.filter(row => row && row.active === true);
    if (active.length !== 1 || !SHA.test(active[0].commitSha || ''))
      return Object.freeze({ status: 'blocked', reason: 'independent_commit_unavailable', runningCodeVerified: false });
    return Object.freeze({ status: 'observed_not_verified',
      candidateCommitSha: active[0].commitSha.toLowerCase(), resourceId,
      runningCodeVerified: false, deploymentShaVerified: false });
  } catch {
    return Object.freeze({ status: 'blocked', reason: 'azure_deployment_metadata_unavailable', runningCodeVerified: false });
  }
}
module.exports = { observeAzureDeploymentCommit };
