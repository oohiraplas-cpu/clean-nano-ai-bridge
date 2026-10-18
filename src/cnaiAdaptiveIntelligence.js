'use strict';

// Deterministic, auditable decision policy; no model-generated actions or
// unverified confidence scores are allowed to authorize production changes.
const RISK = Object.freeze({
  INSPECT_CI_LOGS_AND_PATCH: 1,
  REFETCH_AND_COMPARE: 1,
  RETRY_WITH_BACKOFF: 1,
  REBASE_AND_RETEST: 2,
  REFETCH_RECONCILE_AND_RETEST: 2,
  INSPECT_DEPLOY_LOGS_AND_REDEPLOY: 3
});
function chooseRecovery(candidates, history = []) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be array');
  const tried = new Set(history.filter(x => x && x.success === false).map(x => x.action));
  const eligible = candidates
    .filter(x => x && typeof x.action === 'string' && Object.hasOwn(RISK, x.action))
    .filter(x => !tried.has(x.action))
    .filter(x => x.authorized === true && x.preconditionsVerified === true)
    .map(x => ({ action: x.action, risk: RISK[x.action],
      estimatedCost: Number.isFinite(x.estimatedCost) && x.estimatedCost >= 0
        ? x.estimatedCost : Number.POSITIVE_INFINITY }));
  eligible.sort((a, b) => a.risk - b.risk ||
    a.estimatedCost - b.estimatedCost || a.action.localeCompare(b.action));
  return eligible.length ? { status: 'READY', selected: eligible[0] } :
    { status: 'NEEDS_EVIDENCE', selected: null };
}
function preflight(checks) {
  const required = ['targetLocked', 'sourceVerified', 'backupVerified',
    'authorizationVerified', 'rollbackAvailable'];
  const missing = required.filter(k => !checks || checks[k] !== true);
  return { status: missing.length ? 'BLOCKED' : 'READY', missing };
}
module.exports = { RISK, chooseRecovery, preflight };
