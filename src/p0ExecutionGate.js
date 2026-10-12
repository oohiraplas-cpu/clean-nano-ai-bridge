'use strict';
// Pure preflight guard. This module does not execute writes or grant approval.
const SHA = /^[0-9a-f]{40}$/i;
const STAGES = Object.freeze(['change', 'publish']);
function validateP0ExecutionGate({ operation, targetSha, observedSha, actorId, approvalRecords, backupVerified, testsPassed, appCheckerCritical, deployedSha, expectedPublishedVersion, observedPublishedVersion } = {}) {
  const deny = reason => Object.freeze({ allowed: false, reason });
  if (!['save', 'publish', 'merge', 'deploy'].includes(operation)) return deny('unknown_operation');
  if (!SHA.test(targetSha || '') || !SHA.test(observedSha || '') || targetSha !== observedSha) return deny('head_mismatch');
  if (typeof actorId !== 'string' || !actorId.trim()) return deny('actor_unverified');
  if (backupVerified !== true || testsPassed !== true) return deny('evidence_missing');
  if (!Array.isArray(approvalRecords)) return deny('approval_ledger_unavailable');
  const required = operation === 'save' ? ['change'] : STAGES;
  for (const stage of required) {
    const matches = approvalRecords.filter(record => record && record.stage === stage && record.actorId === actorId && record.targetSha === targetSha && record.approved === true && record.revoked === false && typeof record.approverId === 'string' && record.approverId.trim() && record.approverId !== actorId);
    if (matches.length !== 1) return deny('approval_missing_or_ambiguous_' + stage);
  }
  if (['save', 'publish'].includes(operation) && appCheckerCritical !== 0) return deny('app_checker_unverified');
  if (operation === 'deploy' && deployedSha !== targetSha) return deny('deployed_sha_unverified');
  if (operation === 'publish' && (!expectedPublishedVersion || observedPublishedVersion !== expectedPublishedVersion)) return deny('published_version_unverified');
  return Object.freeze({ allowed: true, reason: null });
}
module.exports = { validateP0ExecutionGate };
