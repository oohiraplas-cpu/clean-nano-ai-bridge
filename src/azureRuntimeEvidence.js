'use strict';
const crypto = require('node:crypto');

// Pure metadata validation: never emit source-map entries, secret values, tokens or profiles.
// Read-only observations are not permission to publish.
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function collectRuntimeEvidence({ settings = {}, deployment = {}, pacProbe = null } = {}) {
  const authMode = settings.POWERAPPS_RUNTIME_AUTH_MODE;
  const map = settings.POWERAPPS_RUNTIME_SOURCE_MAP;
  let mapping = null;
  try { mapping = JSON.parse(map); } catch { /* no contents in report */ }
  const sourceMapSchemaValid = !!mapping && typeof mapping === 'object' && !Array.isArray(mapping)
    && Object.keys(mapping).length > 0 && Object.entries(mapping).every(([key, value]) =>
      typeof key === 'string' && /^[\w.-]+\.pa\.yaml$/.test(key)
      && typeof value === 'string' && /^Src[\\/][\w./\\-]+\.pa\.yaml$/.test(value)
      && !value.split(/[\\/]/).some(part => part === '..'));
  const runtimeProbeVerified = pacProbe?.status === 'ok'
    && pacProbe?.source === 'power-apps-saved-msapp'
    && typeof pacProbe?.runtimeHash === 'string'
    && /^[a-f0-9]{64}$/i.test(pacProbe.runtimeHash);
  const azureSha = deployment.azureDeployedSha;
  const independentShaMatched = sha(azureSha) && sha(deployment.expectedSha)
    && azureSha.toLowerCase() === deployment.expectedSha.toLowerCase()
    && deployment.independentAzureSource === true;
  return Object.freeze({
    managedIdentityModeConfigured: authMode === 'managedIdentity',
    managedIdentityClientIdFormatValid: settings.POWERAPPS_RUNTIME_MI_CLIENT_ID == null
      || settings.POWERAPPS_RUNTIME_MI_CLIENT_ID === '' || uuid(settings.POWERAPPS_RUNTIME_MI_CLIENT_ID),
    sourceMapSchemaValid,
    sourceMapVerified: sourceMapSchemaValid && runtimeProbeVerified,
    pacProfileVerified: runtimeProbeVerified,
    deploymentShaMatched: !!independentShaMatched,
    // No effective-RBAC assertion: listing assignments is not authorization verification.
    effectiveRbacVerified: false
  });
}
module.exports = { collectRuntimeEvidence };
