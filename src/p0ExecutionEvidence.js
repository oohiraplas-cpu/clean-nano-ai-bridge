'use strict';
// Strict adapter around the existing SharePoint ApprovalLedger. Never accepts caller-supplied approval flags.
const SHA = /^[a-f0-9]{40}$/i;
const OPERATIONS = new Set(['save', 'publish', 'merge', 'deploy']);
const requiredStages = operation => operation === 'save' ? ['change'] : ['change', 'publish'];
const deny = reason => Object.freeze({ allowed: false, reason });
async function verifyBeforeMutation({ ledger, operation, targetSha, observedSha, requestId, actorId, backupVerified, testsPassed, expected = {} } = {}) {
  if (!OPERATIONS.has(operation)) return deny('unknown_operation');
  if (!SHA.test(targetSha || '') || targetSha !== observedSha) return deny('head_mismatch');
  if (!requestId || !actorId || backupVerified !== true || testsPassed !== true) return deny('preflight_evidence_missing');
  if (!ledger || ledger.configured !== true || typeof ledger.check !== 'function') return deny('ledger_not_configured');
  const approvers = [];
  for (const [stepIndex, stage] of requiredStages(operation).entries()) {
    // The existing ledger checks requestId, stepIndex, tool, status, expiry and revocation.
    let decision;
    try {
      decision = await ledger.check({ requestId, stepIndex, tool: operation + ':' + stage });
    } catch {
      return deny('ledger_unreadable');
    }
    if (!decision || decision.approved !== true || typeof decision.approver !== 'string' || !decision.approver.trim()) return deny('approval_missing_' + stage);
    if (decision.approver === actorId) return deny('self_approval_' + stage);
    approvers.push(decision.approver);
  }
  // The existing ledger does not bind approvals to targetSha, environment or changeHash.
  // A trustworthy independent binding must be supplied by a separate ledger extension.
  if (expected.ledgerBindingVerified !== true) return deny('ledger_binding_unverified');
  return Object.freeze({ allowed: true, reason: null, stages: approvers.length });
}
function verifyAfterMutation({ operation, expectedSha, actualSha, appCheckerCritical, expectedVersion, observedVersion, operationConfirmed } = {}) {
  if (!OPERATIONS.has(operation)) return deny('unknown_operation');
  if (!SHA.test(expectedSha || '') || actualSha !== expectedSha) return deny('result_sha_unverified');
  if (operationConfirmed !== true) return deny('operation_unverified');
  if (['save', 'publish'].includes(operation) && appCheckerCritical !== 0) return deny('app_checker_unverified');
  if (['save', 'publish'].includes(operation) && (!expectedVersion || expectedVersion !== observedVersion)) return deny('version_unverified');
  return Object.freeze({ allowed: true, reason: null });
}
module.exports = { verifyBeforeMutation, verifyAfterMutation };
