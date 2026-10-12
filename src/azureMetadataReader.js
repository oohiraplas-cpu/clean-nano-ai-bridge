'use strict';
// Explicitly instantiated, read-only Azure metadata adapter.
// Does not access app settings, secrets, tokens, or role assignments.
// Caller must deliberately inject this adapter into createApp's bridgeServices.
const { collect } = require('../scripts/check-azure-metadata-only');
const { assessAzureDiagnostic } = require('./azureDiagnostic');
function createAzureMetadataReader({ collectMetadata = collect } = {}) {
  if (typeof collectMetadata !== 'function') throw new TypeError('invalid_metadata_collector');
  return Object.freeze({
    readDeploymentMetadata: async () => {
      let observed;
      try {
        observed = await collectMetadata();
      } catch {
        // Missing Azure CLI, authentication, or metadata access remains an explicit
        // read-only blocker; never leak upstream errors or turn it into an HTTP 500.
        return Object.freeze({ status: 'blocked', reason: 'azure_metadata_unavailable', resourceIdMatched: false, deploymentEntries: [], diagnostic: assessAzureDiagnostic() });
      }
      if (!observed || observed.resourceIdMatched !== true ||
          observed.deploymentMetadataAccessible !== true ||
          !Array.isArray(observed.deploymentEntries)) {
        return Object.freeze({ status: 'blocked', reason: 'azure_metadata_unverified', resourceIdMatched: false, deploymentEntries: [], diagnostic: assessAzureDiagnostic() });
      }
      return Object.freeze({ resourceIdMatched: true, deploymentEntries: observed.deploymentEntries.slice(0, 30).map(entry => ({
        deploymentId: typeof entry?.deploymentId === 'string' ? entry.deploymentId.slice(0, 100) : null,
        active: entry?.active === true,
        status: Number.isInteger(entry?.status) ? entry.status : null,
        receivedTime: typeof entry?.receivedTime === 'string' ? entry.receivedTime.slice(0, 40) : null
      })),
        diagnostic: assessAzureDiagnostic({
          armResourceId: observed.armResourceId,
          armObservedIndependently: observed.armObservedIndependently === true,
          managedIdentityAssigned: observed.managedIdentityAssigned,
          managedIdentityObservedIndependently: observed.managedIdentityObservedIndependently === true,
          effectiveRbacVerifiedIndependently: observed.effectiveRbacVerifiedIndependently === true,
          effectiveRbacScopeMatched: observed.effectiveRbacScopeMatched === true,
          independentAzureSha: observed.independentAzureSha,
          independentAzureShaVerified: observed.independentAzureShaVerified === true,
          expectedGithubSha: observed.expectedGithubSha
        }) });
    }
  });
}
module.exports = { createAzureMetadataReader };
