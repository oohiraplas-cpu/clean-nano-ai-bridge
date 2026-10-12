'use strict';
// Explicitly instantiated, read-only Azure metadata adapter.
// Does not access app settings, secrets, tokens, or role assignments.
// Caller must deliberately inject this adapter into createApp's bridgeServices.
const { collect } = require('../scripts/check-azure-metadata-only');
function createAzureMetadataReader({ collectMetadata = collect } = {}) {
  if (typeof collectMetadata !== 'function') throw new TypeError('invalid_metadata_collector');
  return Object.freeze({
    readDeploymentMetadata: async () => {
      const observed = await collectMetadata();
      if (!observed || observed.resourceIdMatched !== true ||
          observed.deploymentMetadataAccessible !== true ||
          !Array.isArray(observed.deploymentEntries)) {
        return Object.freeze({ resourceIdMatched: false, deploymentEntries: [] });
      }
      return Object.freeze({ resourceIdMatched: true, deploymentEntries: observed.deploymentEntries });
    }
  });
}
module.exports = { createAzureMetadataReader };
