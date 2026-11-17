'use strict';
const { diagnoseConnection, rotationPlan } = require('./connectionRepairDiagnostic');

// Safe orchestration contract. No credentials or authentication responses are persisted.
const PROVIDERS = Object.freeze({
  azure: 'entra',
  azureAi: 'entra',
  powerApps: 'entra',
  powerAutomate: 'entra',
  copilotStudio: 'oauth',
  githubAzureDeployment: 'oidc',
  bridgeMcp: 'api_key',
  bridgeConnector: 'api_key'
});
const VALID_OPERATIONS = new Set(['diagnose', 'repair', 'rotate']);
const APPROVAL_REQUIRED = new Set(['repair', 'rotate']);
const VALID_APPROVAL = Object.freeze({ approved: true, scope: 'connection_repair' });
function executeConnectionRequest(request = {}, adapters = {}) {
  const { service, operation, approved, approvalScope, endpointPath, status, configured } = request;
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, service) || !VALID_OPERATIONS.has(operation)) {
    return { status: 'BLOCKED', reason: 'invalid_target_or_operation' };
  }
  if (operation === 'diagnose') return diagnoseConnection({ service, status, configured, endpointPath });
  // Explicit scoped approval is mandatory; never infer approval from user role or mere tool access.
  if (approved !== VALID_APPROVAL.approved || approvalScope !== VALID_APPROVAL.scope) {
    return { status: 'HUMAN_APPROVAL_REQUIRED', reason: 'scoped_approval_missing', service, operation };
  }
  if (operation === 'rotate') return rotationPlan(service); // Plan only: no secret mutation.
  // Repair is intentionally restricted to provider-native, independently verified adapters.
  // The adapter must not receive credentials through this request or return them in its result.
  const adapter = adapters[service];
  if (!adapter || typeof adapter.diagnose !== 'function') {
    return { status: 'BLOCKED', reason: 'provider_adapter_unavailable', service };
  }
  // Never trust arbitrary adapter output as verified repair.
  let diagnosis;
  try {
    diagnosis = adapter.diagnose();
  } catch {
    return { status: 'BLOCKED', reason: 'provider_diagnosis_failed', service };
  }
  if (!diagnosis || diagnosis.verified !== true || typeof diagnosis.safeAction !== 'string') {
    return { status: 'BLOCKED', reason: 'provider_evidence_missing', service };
  }
  // Explicit allowlist of non-mutating operations until provider-specific rollback is implemented.
  if (diagnosis.safeAction !== 'read_only_check') {
    return { status: 'BLOCKED', reason: 'mutation_adapter_not_approved', service };
  }
  return { status: 'PARTIAL', reason: 'read_only_diagnosis_verified', service, nextAction: 'provider_specific_repair_gate' };
}
module.exports = { PROVIDERS, executeConnectionRequest };
