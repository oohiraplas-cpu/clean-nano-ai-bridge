'use strict';
// Explicitly instantiated, read-only Azure metadata adapter.
// Does not access app settings, secrets, tokens, or role assignments.
// Caller must deliberately inject this adapter into createApp's bridgeServices.
const { collect } = require('../scripts/check-azure-metadata-only');
const { assessAzureDiagnostic } = require('./azureDiagnostic');
const { sanitizeMetadataFailures } = require('./azureMetadataFailures');
function createAzureMetadataReader({ collectMetadata = collect } = {}) {
  if (typeof collectMetadata !== 'function') throw new TypeError('invalid_metadata_collector');
  return Object.freeze({
    readDeploymentMetadata: async () => {
      let observed;
      try {
        observed = await collectMetadata();
      } catch (error) {
        // Missing Azure CLI, authentication, or metadata access remains an explicit
        // read-only blocker; never leak upstream errors or turn it into an HTTP 500.
        const failures = sanitizeMetadataFailures(error?.metadataFailures);
        return Object.freeze({ status: 'blocked', reason: 'azure_metadata_unavailable', resourceIdMatched: false, deploymentEntries: [], diagnostic: assessAzureDiagnostic(),
          metadataFailures: failures.length ? failures : [{ stage: 'metadata_reader', reason: 'collector_failed' }] });
      }
      if (!observed || observed.resourceIdMatched !== true ||
          observed.deploymentMetadataAccessible !== true ||
          !Array.isArray(observed.deploymentEntries)) {
        const failures = sanitizeMetadataFailures(observed?.metadataFailures);
        return Object.freeze({ status: 'blocked', reason: 'azure_metadata_unverified', resourceIdMatched: observed?.resourceIdMatched === true, deploymentEntries: [], diagnostic: assessAzureDiagnostic(),
          metadataFailures: failures.length ? failures : [{ stage: 'metadata_reader', reason: 'invalid_response' }] });
      }
      return Object.freeze({ resourceIdMatched: true, metadataFailures: sanitizeMetadataFailures(observed.metadataFailures), deploymentEntries: observed.deploymentEntries.slice(0, 30).map(entry => ({
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
