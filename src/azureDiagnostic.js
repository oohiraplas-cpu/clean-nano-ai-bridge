'use strict';
// Pure, read-only evidence assessment. Caller observations are never treated as
// Azure authority unless their independent provenance is explicitly verified.
const SHA = /^[a-f0-9]{40}$/i;
const RESOURCE = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge$/i;
function assessAzureDiagnostic(input = {}) {
  const expected = typeof input.expectedGithubSha === 'string' && SHA.test(input.expectedGithubSha) ? input.expectedGithubSha.toLowerCase() : null;
  const azure = typeof input.independentAzureSha === 'string' && SHA.test(input.independentAzureSha) && input.independentAzureShaVerified === true
    ? input.independentAzureSha.toLowerCase() : null;
  const checks = {
    armResourceId: input.armObservedIndependently === true && RESOURCE.test(input.armResourceId || '') ? 'confirmed' : 'unconfirmed',
    managedIdentity: input.managedIdentityObservedIndependently === true && input.managedIdentityAssigned === true ? 'confirmed' : 'unconfirmed',
    effectiveRbac: input.effectiveRbacVerifiedIndependently === true && input.effectiveRbacScopeMatched === true ? 'confirmed' : 'unconfirmed',
    independentDeploymentSha: azure ? 'confirmed' : 'unconfirmed',
    githubShaMatch: azure && expected ? (azure === expected ? 'confirmed' : 'blocked') : 'unconfirmed'
  };
  const evidence = {
    armResourceId: checks.armResourceId === 'confirmed' ? input.armResourceId : null,
    managedIdentity: checks.managedIdentity === 'confirmed' ? 'independently_observed' : null,
    effectiveRbac: checks.effectiveRbac === 'confirmed' ? 'independently_verified_scope' : null,
    azureSha: azure,
    githubSha: expected,
    source: 'caller_supplied_independent_observations'
  };
  const status = Object.values(checks).every(v => v === 'confirmed') ? 'confirmed' : 'blocked';
  return Object.freeze({ status, checks: Object.freeze(checks), evidence: Object.freeze(evidence) });
}
module.exports = { assessAzureDiagnostic };
