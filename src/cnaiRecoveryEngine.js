'use strict';

// Pure recovery planner. An executor may perform only an allowlisted action
// after validating the target, authorization, evidence, and operation scope.
const MAX_RETRIES = 3;
const RECOVERABLE = Object.freeze({
  CI_FAILURE: 'INSPECT_CI_LOGS_AND_PATCH',
  GIT_CONFLICT: 'REBASE_AND_RETEST',
  AZURE_DEPLOY_FAILURE: 'INSPECT_DEPLOY_LOGS_AND_REDEPLOY',
  POWERAPPS_SOURCE_MISMATCH: 'REFETCH_AND_COMPARE',
  SAVE_READBACK_MISMATCH: 'REFETCH_RECONCILE_AND_RETEST',
  TRANSIENT_NETWORK: 'RETRY_WITH_BACKOFF'
});
const HUMAN_ONLY = new Set([
  'PERMISSION_DENIED', 'DATA_INTEGRITY_RISK', 'BILLING_CHANGE',
  'PRODUCTION_AUTHORIZATION_MISSING', 'SECRET_EXPOSURE',
  'UNKNOWN_TARGET', 'UNVERIFIED_SOURCE'
]);
function planRecovery(state, failure) {
  if (!state || !failure || typeof failure.code !== 'string')
    throw new Error('state and failure code required');
  const code = failure.code;
  const attempts = Number.isInteger(state.recoveryAttempts) ? state.recoveryAttempts : 0;
  const signature = String(failure.signature || code);
  const repeats = state.lastFailureSignature === signature
    ? (state.sameFailureCount || 0) + 1 : 1;
  const common = { ...state, lastFailureSignature: signature,
    sameFailureCount: repeats, recoveryAttempts: attempts + 1 };
  if (HUMAN_ONLY.has(code) || !RECOVERABLE[code])
    return { ...common, status: 'BLOCKED', reason: code, recoveryAction: null };
  if (attempts >= MAX_RETRIES || repeats >= MAX_RETRIES)
    return { ...common, status: 'BLOCKED', reason: 'RECOVERY_BUDGET_EXHAUSTED', recoveryAction: null };
  return { ...common, status: 'RECOVERING', reason: code,
    recoveryAction: RECOVERABLE[code] };
}
function recoveryVerified(state, evidenceId) {
  if (!state || state.status !== 'RECOVERING' || !state.recoveryAction)
    throw new Error('no active recovery');
  if (typeof evidenceId !== 'string' || !evidenceId.trim())
    throw new Error('verified recovery evidence required');
  return { ...state, status: 'READY', recoveryAction: null,
    recoveryEvidence: [...(state.recoveryEvidence || []), evidenceId] };
}
module.exports = { MAX_RETRIES, RECOVERABLE, HUMAN_ONLY, planRecovery, recoveryVerified };
