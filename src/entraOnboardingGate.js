'use strict';

/**
 * Fail-closed, side-effect-free decision gate for Forms-free Entra onboarding.
 * This module DOES NOT create identities or mark approvals. It produces a plan
 * only after server-trusted approval and full duplicate/permission checks.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPES = new Set(['社員', 'アルバイト', '協力会社']);
const norm = value => String(value || '').normalize('NFKC').trim().toLowerCase();
const deny = (reason) => ({ status: 'BLOCKED', reason, canWrite: false });

function planEntraOnboarding(request, evidence) {
  if (!request || !evidence || typeof request !== 'object' || typeof evidence !== 'object') return deny('missing_input');
  const { requestId, displayName, email, category, employeeId } = request;
  if (!GUID.test(String(requestId || ''))) return deny('invalid_request_id');
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 256) return deny('invalid_name');
  if (!EMAIL.test(String(email || '')) || String(email).length > 254) return deny('invalid_email');
  if (!TYPES.has(category)) return deny('invalid_category');
  if (category !== '協力会社' && !String(employeeId || '').trim()) return deny('missing_employee_id');

  // Evidence must be supplied by a trusted server, never directly by the Power Apps client.
  if (evidence.source !== 'trusted_server' || evidence.tenantVerified !== true) return deny('untrusted_evidence');
  if (evidence.requestId !== requestId) return deny('request_mismatch');
  if (evidence.approval?.verified !== true || evidence.approval?.requestId !== requestId ||
      evidence.approval?.authorizedApprover !== true || evidence.approval?.revoked !== false)
    return deny('approval_not_verified');
  if (evidence.duplicateCheck?.complete !== true || evidence.duplicateCheck?.atomicGuard !== true)
    return deny('duplicate_check_incomplete');
  if (evidence.duplicateCheck?.matched !== false) return deny('duplicate_or_uncertain');
  if (evidence.graphPermissionVerified !== true || evidence.policyVerified !== true ||
      evidence.costVerifiedNoNewCharge !== true) return deny('permissions_policy_or_cost_unverified');
  if (evidence.existingIdentityReconciled !== true) return deny('identity_reconciliation_unverified');
  if (evidence.targetEmail && norm(evidence.targetEmail) !== norm(email)) return deny('email_mismatch');

  return {
    status: 'READY_FOR_AUTHORIZED_EXECUTOR',
    canWrite: false, // a plan is NEVER an authorization token
    requestId,
    operation: category === '協力会社' ? 'entra_invite_user' : 'graph_manage.user_create',
    category,
    verificationRequired: ['graph_readback', 'ledger_link_readback', 'powerapps_access', 'audit']
  };
}

module.exports = { planEntraOnboarding };
