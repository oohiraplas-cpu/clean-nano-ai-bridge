'use strict';

// Read-only diagnostic. Never return environment variable values or identity IDs.
const REQUIRED = Object.freeze([
  'POWERAPPS_RUNTIME_SOURCE_ADAPTER',
  'POWERAPPS_RUNTIME_AUTH_MODE',
  'POWERAPPS_RUNTIME_PAC_PROFILE_HOME',
  'POWERAPPS_RUNTIME_SOURCE_MAP'
]);
const OPTIONAL = Object.freeze([
  'POWERAPPS_RUNTIME_MI_CLIENT_ID',
  'POWERAPPS_RUNTIME_PYTHON',
  'POWERAPPS_RUNTIME_PAC'
]);
function runtimeConfigurationStatus(env = process.env) {
  const keys = {};
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    keys[key] = Object.prototype.hasOwnProperty.call(env, key)
      && typeof env[key] === 'string' && env[key].trim() !== ''
      ? 'present' : 'missing';
  }
  // Presence is NOT proof that a setting is valid, that PAC is authenticated,
  // or that Azure managed identity is assigned. No secrets or values returned.
  return {
    status: REQUIRED.every((key) => keys[key] === 'present') ? 'presence_only' : 'missing_configuration',
    keys,
    azureIdentity: 'unverified',
    pacAuthentication: 'unverified',
    sourceMapObserved: false,
    runtimeSourceObserved: false
  };
}
module.exports = { runtimeConfigurationStatus };
