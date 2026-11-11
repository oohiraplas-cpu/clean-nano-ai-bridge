'use strict';

// Read-only assessment of caller-supplied Azure observations. Never fetch secrets,
// invoke az CLI, modify Azure resources, or claim runtime connectivity.
const REQUIRED = Object.freeze([
  'resourceIdMatched', 'deploymentShaMatched', 'managedIdentityAssigned',
  'rbacReadVerified', 'runtimeKeysPresent', 'pacProfileVerified',
  'sourceMapVerified', 'healthVerified'
]);

function assessAzureReadiness(observation = {}) {
  const checks = {};
  for (const key of REQUIRED) checks[key] = observation[key] === true ? 'verified' : 'unverified';
  const missing = REQUIRED.filter(key => checks[key] !== 'verified');
  return Object.freeze({ status: missing.length ? 'blocked' : 'ready_for_review', checks, missing });
}

module.exports = { assessAzureReadiness, REQUIRED };
