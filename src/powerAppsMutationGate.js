'use strict';

// Draft-only authorization boundary for future Power Apps write adapters.
// Never call a mutation unless every trusted dependency has been injected and
// verified. This module does NOT activate the legacy server write routes.
function createPowerAppsMutationGate({ reserveApproval, recheckApproval, readCurrentSha,
  verifyTarget, verifyBackup, verifyPostcondition } = {}) {
  return async function execute({ operation, approvalId, requestId, appId,
    environmentId, targetSha, changeHash, mutate, expectedPostcondition } = {}) {
    const blocked = (reason) => ({ status: 'BLOCKED', success: false, reason });
    if (!['update', 'save', 'publish'].includes(operation) ||
        !/^[1-9][0-9]*$/.test(String(approvalId || '')) ||
        typeof requestId !== 'string' || !requestId.trim() ||
        typeof appId !== 'string' || !appId.trim() ||
        typeof environmentId !== 'string' || !environmentId.trim() ||
        !/^[a-f0-9]{40}$/i.test(targetSha || '') ||
        !/^[a-f0-9]{64}$/i.test(changeHash || '') ||
        ![reserveApproval, recheckApproval, readCurrentSha, verifyTarget,
          verifyBackup, verifyPostcondition, mutate].every(fn => typeof fn === 'function')) {
      return blocked('mutation_gate_not_configured');
    }
    const scope = { operation, approvalId, requestId, appId, environmentId, targetSha, changeHash };
    let mutationAttempted = false;
    try {
      if (await verifyTarget(scope) !== true || await verifyBackup(scope) !== true) {
        return blocked('target_or_backup_unverified');
      }
      if (await readCurrentSha(scope) !== targetSha) return blocked('stale_target_sha');
      // reserveApproval must verify an independent human directory identity,
      // scoped ledger decision and atomic If-Match ETag, not a caller token.
      const reservation = await reserveApproval(scope);
      if (reservation?.reserved !== true || reservation.singleUseVerified !== true ||
          reservation.approvalActiveVerified !== true ||
          reservation.targetSha !== targetSha || reservation.requestId !== requestId ||
          reservation.operation !== operation ||
          typeof reservation.executionId !== 'string' || !reservation.executionId) {
        return blocked('approval_reservation_failed');
      }
      if (await readCurrentSha(scope) !== targetSha) return blocked('sha_changed_after_reservation');
      if (await recheckApproval({ ...scope, executionId: reservation.executionId }) !== true) {
        return blocked('approval_revoked_or_unverified');
      }
      // Recheck is single-use; do not retry after any uncertain mutation result.
      mutationAttempted = true;
      const result = await mutate({ ...scope, executionId: reservation.executionId });
      if (result?.success !== true) return { ...blocked('mutation_failed_or_uncertain'), recoveryRequired: true, retryAllowed: false };
      if (await verifyPostcondition({ ...scope, result, expectedPostcondition }) !== true) {
        // The mutation may have succeeded: do not automatically replay or roll back.
        // Require independent state inspection and a new human-approved recovery action.
        return { ...blocked('postcondition_unverified'), recoveryRequired: true, retryAllowed: false };
      }
      return { status: 'VERIFIED', success: true, result };
    } catch {
      return mutationAttempted
        ? { ...blocked('mutation_outcome_unknown'), recoveryRequired: true, retryAllowed: false }
        : blocked('mutation_gate_exception');
    }
  };
}

module.exports = { createPowerAppsMutationGate };
