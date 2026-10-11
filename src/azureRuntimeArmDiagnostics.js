'use strict';
const { runtimeConfigurationStatus } = require('./azureRuntimeDiagnostics');

const RESOURCE = 'https://management.azure.com';
const KEYS = Object.freeze([
  'POWERAPPS_RUNTIME_SOURCE_ADAPTER','POWERAPPS_RUNTIME_AUTH_MODE',
  'POWERAPPS_RUNTIME_PAC_PROFILE_HOME','POWERAPPS_RUNTIME_SOURCE_MAP',
  'POWERAPPS_RUNTIME_MI_CLIENT_ID','POWERAPPS_RUNTIME_PYTHON','POWERAPPS_RUNTIME_PAC'
]);
const RESOURCE_PATTERN = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_.()\-]+\/providers\/Microsoft\.Web\/sites\/[A-Za-z0-9-]+$/i;
function blocked(reason, local) {
  return { ...local, arm: { status: 'blocked', reason, managedIdentity: 'unverified', settings: 'unverified' } };
}
async function azureRuntimeArmDiagnostics(env = process.env, fetchImpl = globalThis.fetch) {
  const local = runtimeConfigurationStatus(env);
  const resourceId = env.AZURE_RUNTIME_DIAGNOSTIC_RESOURCE_ID;
  if (typeof resourceId !== 'string' || !RESOURCE_PATTERN.test(resourceId)) return blocked('target_not_configured', local);
  // App Service managed identity endpoint only. Never fall back to service principal, CLI, or IMDS.
  const endpoint = env.IDENTITY_ENDPOINT;
  const header = env.IDENTITY_HEADER;
  if (typeof endpoint !== 'string' || !/^https?:\/\/127\.0\.0\.1(?::\d+)?\//.test(endpoint) ||
      typeof header !== 'string' || !header) return blocked('managed_identity_endpoint_unavailable', local);
  if (typeof fetchImpl !== 'function') return blocked('fetch_unavailable', local);
  try {
    const tokenUrl = new URL(endpoint);
    tokenUrl.searchParams.set('api-version', '2019-08-01');
    tokenUrl.searchParams.set('resource', RESOURCE + '/');
    const tokenResponse = await fetchImpl(tokenUrl.toString(), {
      method: 'GET', headers: { 'X-IDENTITY-HEADER': header }, signal: AbortSignal.timeout(5000)
    });
    if (!tokenResponse.ok) return blocked('token_unavailable', local);
    const tokenBody = await tokenResponse.json();
    if (typeof tokenBody.access_token !== 'string' || !tokenBody.access_token) return blocked('token_unavailable', local);
    const headers = { Authorization: 'Bearer ' + tokenBody.access_token };
    const identityResponse = await fetchImpl(RESOURCE + resourceId + '?api-version=2023-12-01', {
      method: 'GET', headers, signal: AbortSignal.timeout(5000)
    });
    if (!identityResponse.ok) return blocked('identity_read_denied', local);
    const identityBody = await identityResponse.json();
    const identity = identityBody?.identity;
    const managedIdentity = identity?.type === 'SystemAssigned' || identity?.type === 'SystemAssigned, UserAssigned'
      || identity?.type === 'UserAssigned' || identity?.type === 'UserAssigned, SystemAssigned'
      ? { systemAssigned: identity.type.includes('SystemAssigned'), userAssigned: identity.type.includes('UserAssigned') }
      : identity?.type === 'None' || !identity ? { systemAssigned: false, userAssigned: false } : 'unverified';
    // ARM list appsettings is POST by Azure API contract but is a non-mutating read.
    const settingsResponse = await fetchImpl(RESOURCE + resourceId + '/config/appsettings/list?api-version=2023-12-01', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000)
    });
    if (!settingsResponse.ok) return { ...local, arm: { status: 'partial', managedIdentity, settings: 'unverified', reason: 'settings_read_denied' } };
    const settingsBody = await settingsResponse.json();
    if (!settingsBody?.properties || typeof settingsBody.properties !== 'object' || Array.isArray(settingsBody.properties))
      return { ...local, arm: { status: 'partial', managedIdentity, settings: 'unverified', reason: 'invalid_settings_response' } };
    const keys = Object.fromEntries(KEYS.map(k => [k, Object.prototype.hasOwnProperty.call(settingsBody.properties, k) ? 'present' : 'missing']));
    return { ...local, arm: { status: 'observed', managedIdentity, settings: 'presence_only', keys } };
  } catch {
    return blocked('arm_request_failed', local);
  }
}
module.exports = { azureRuntimeArmDiagnostics };
