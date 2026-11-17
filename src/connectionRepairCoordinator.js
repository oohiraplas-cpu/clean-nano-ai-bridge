'use strict';
// Deterministic, fail-closed repair coordinator. No credentials are read or returned.
// Provider adapters must implement snapshot, apply, verify, audit, rollback separately.
const { diagnoseConnection } = require('./connectionRepairDiagnostic');
const MUTATING = new Set(['rotate_credential','change_permissions','change_production_settings','revoke_credential']);
// A short user utterance is accepted only against an already stored, scoped,
// unexpired pending request. The pending request must be retrieved by a trusted
// server-side workflow, never supplied by the client as an authorization grant.
function resolveApprovalUtterance(utterance, pending) {
  if (typeof utterance !== 'string' || utterance.trim() !== '承認する') {
    return { status: 'HUMAN_APPROVAL_REQUIRED', reason: 'explicit_approval_missing' };
  }
  if (!pending || pending.source !== 'trusted_server' ||
      pending.status !== 'pending' || pending.presentedToUser !== true ||
      pending.requestId === undefined || typeof pending.requestId !== 'string' ||
      pending.requestId.length < 8 ||
      typeof pending.service !== 'string' || typeof pending.action !== 'string' ||
      !MUTATING.has(pending.action) ||
      !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now()) {
    return { status: 'BLOCKED', reason: 'no_valid_pending_approval' };
  }
  return {
    status: 'PARTIAL',
    reason: 'approval_intent_verified_pending_server_consumption',
    requestId: pending.requestId,
    service: pending.service,
    action: pending.action,
    // Do not return granted:true: the trusted server must atomically consume
    // this request and bind the authenticated user before executing a write.
    execution: 'not_executed'
  };
}
function evaluateRepair(request = {}) {
  const { service, httpStatus, configured, endpointPath, action = 'diagnose', approval, capability } = request;
  const diagnostic = diagnoseConnection({ service, status: httpStatus, configured, endpointPath });
  if (action === 'diagnose') return { ...diagnostic, execution: 'read_only' };
  if (!MUTATING.has(action)) return { status: 'BLOCKED', reason: 'unsupported_action' };
  if (!capability || capability.provider !== service || capability.canWrite !== true ||
      capability.canVerify !== true || capability.canRollback !== true ||
      capability.secureCredentialChannel !== true) {
    return { status: 'BLOCKED', reason: 'provider_capability_not_verified' };
  }
  if (!approval || approval.granted !== true || approval.service !== service ||
      approval.action !== action || typeof approval.requestId !== 'string' ||
      approval.requestId.length < 8 || approval.expiresAt === undefined ||
      !Number.isFinite(approval.expiresAt) || approval.expiresAt <= Date.now()) {
    return { status: 'HUMAN_APPROVAL_REQUIRED', reason: 'scoped_approval_required' };
  }
  return {
    status: 'PARTIAL',
    reason: 'ready_for_provider_adapter',
    execution: 'not_executed',
    requestId: approval.requestId,
    requiredGates: ['snapshot', 'secure_write', 'readback', 'authorized_e2e', 'audit', 'rollback_ready']
  };
}
module.exports = { evaluateRepair, resolveApprovalUtterance };
