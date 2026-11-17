'use strict';

// Read-only connection diagnosis. Never return, log, compare or rotate secret values.
// Actual rotation must use a provider-native secure channel and an approved change gate.
const SERVICES = Object.freeze({
  bridgeMcp: { path: '/mcp', setting: 'MCP_API_KEY', method: 'api_key' },
  bridgeConnector: { path: '/connector/mcp', setting: 'CONNECTOR_API_KEY', method: 'api_key' },
  azure: { method: 'managed_identity_or_oidc' },
  azureAi: { method: 'managed_identity_or_entra' },
  powerApps: { method: 'entra_or_delegated_connection' },
  powerAutomate: { method: 'entra_or_delegated_connection' },
  copilotStudio: { method: 'oauth_or_entra' },
  githubAzureDeployment: { method: 'oidc' }
});
const SAFE_CODES = new Set([200, 400, 401, 403, 404, 429, 500, 502, 503, 504]);
function diagnoseConnection({ service, status, configured, endpointPath } = {}) {
  if (!Object.prototype.hasOwnProperty.call(SERVICES, service)) {
    return { status: 'BLOCKED', reason: 'unknown_service', nextAction: 'resolve_target' };
  }
  const target = SERVICES[service];
  if (endpointPath !== undefined && (typeof endpointPath !== 'string' || endpointPath !== target.path)) {
    return { status: 'BLOCKED', reason: 'endpoint_mismatch', nextAction: 'check_endpoint_mapping' };
  }
  if (configured === false) return { status: 'BLOCKED', reason: 'not_configured', nextAction: 'configure_securely' };
  if (!Number.isInteger(status) || !SAFE_CODES.has(status)) {
    return { status: 'BLOCKED', reason: 'unverified_response', nextAction: 'run_readonly_probe' };
  }
  const reasons = {
    200: ['PASS', 'responding', 'verify_authorized_operation'],
    400: ['PARTIAL', 'bad_request', 'verify_protocol_contract'],
    401: ['BLOCKED', 'unauthorized', 'check_client_auth_without_exposing_secrets'],
    403: ['BLOCKED', 'forbidden', 'check_permissions'],
    404: ['BLOCKED', 'not_found', 'check_endpoint_and_feature_flags'],
    429: ['PARTIAL', 'rate_limited', 'retry_with_backoff'],
    500: ['FAIL', 'upstream_error', 'inspect_redacted_server_diagnostics'],
    502: ['FAIL', 'gateway_error', 'inspect_redacted_gateway_diagnostics'],
    503: ['BLOCKED', 'unavailable_or_unconfigured', 'check_service_and_configuration'],
    504: ['FAIL', 'gateway_timeout', 'check_dependency_timeout']
  };
  const [result, reason, nextAction] = reasons[status];
  return { status: result, reason, nextAction, authentication: target.method };
}
function rotationPlan(service) {
  if (!Object.prototype.hasOwnProperty.call(SERVICES, service)) {
    return { status: 'BLOCKED', reason: 'unknown_service' };
  }
  return {
    status: 'HUMAN_APPROVAL_REQUIRED',
    service,
    steps: ['snapshot_metadata_only', 'prepare_new_credential_in_secure_provider',
      'update_consumers_via_secure_channel', 'verify_authorized_read',
      'revoke_old_credential_after_verified_cutover', 'audit_without_secret_values'],
    warning: 'No secret generation, disclosure, configuration mutation or revocation is performed.'
  };
}
module.exports = { SERVICES, diagnoseConnection, rotationPlan };
