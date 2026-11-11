'use strict';
// Independent Verifier for CNAI Router records.
//
// Deliberately does not import cnaiRouter's internal state or trust its own self-report.
// It re-checks the PUBLIC snapshot + audit trail + checkpoint history that the router
// already exposes via getStatus/getAuditTrail/getCheckpoint, and only those.
// A violation here means the router's own COMPLETED/PASS claim is not trustworthy.

const { ROUTES, EXECUTION_STATUSES } = require('./cnaiRouter');
const { containsLikelySecret } = require('./secretMasking');

const REQUIRED_FIELDS = Object.freeze([
  'requestId', 'correlationId', 'requestType', 'riskLevel', 'costClass',
  'selectedRoute', 'executionStatus', 'verificationStatus', 'checkpointId',
  'auditId', 'startedAt', 'completedAt', 'errorCode', 'errorSummary'
]);

const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'ROLLED_BACK']);

function stringifyForSecretScan(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * @param {object} snapshotResult - result of cnaiRouter.getStatus()
 * @param {object} auditResult - result of cnaiRouter.getAuditTrail()
 * @param {object} checkpointResult - result of cnaiRouter.getCheckpoint()
 * @returns {{ok: boolean, violations: string[]}}
 */
function verifyRouterRecord(snapshotResult, auditResult, checkpointResult) {
  const violations = [];
  const push = (message) => violations.push(message);

  if (!snapshotResult || typeof snapshotResult !== 'object') {
    return { ok: false, violations: ['snapshot_missing'] };
  }

  // 1. Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in snapshotResult)) push(`missing_field:${field}`);
  }

  // 2. State machine legality
  if (!EXECUTION_STATUSES.includes(snapshotResult.executionStatus)) {
    push(`invalid_execution_status:${snapshotResult.executionStatus}`);
  }
  if (snapshotResult.selectedRoute && !ROUTES.includes(snapshotResult.selectedRoute)) {
    push(`invalid_route:${snapshotResult.selectedRoute}`);
  }

  // 3. Anti-fabrication: COMPLETED must be backed by an actual VERIFIED verification.
  // This is the single most important check — it is what stops "report COMPLETE without
  // evidence" from passing an independent review.
  if (snapshotResult.executionStatus === 'COMPLETED' && snapshotResult.verificationStatus !== 'VERIFIED') {
    push('unverified_result_marked_completed');
  }
  if (snapshotResult.verificationStatus === 'VERIFIED' && snapshotResult.executionStatus !== 'COMPLETED') {
    push('verified_without_completed_status');
  }

  // 4. Terminal consistency: a terminal record must carry a checkpointId and a completedAt.
  if (TERMINAL_STATUSES.includes(snapshotResult.executionStatus)) {
    if (!snapshotResult.checkpointId) push('terminal_without_checkpoint');
    if (!snapshotResult.completedAt) push('terminal_without_completedAt');
  }

  // 5. Audit trail consistency
  if (!auditResult || !Array.isArray(auditResult.trail) || auditResult.trail.length === 0) {
    push('audit_trail_missing');
  } else {
    if (auditResult.trail[0].event !== 'RECEIVED') push('audit_trail_does_not_start_with_received');
    if (snapshotResult.auditId && auditResult.auditId !== snapshotResult.auditId) push('audit_id_mismatch');
    if (snapshotResult.executionStatus === 'ROLLED_BACK') {
      const rolledBackEntry = auditResult.trail.find((entry) => entry.event === 'ROLLED_BACK');
      if (!rolledBackEntry || rolledBackEntry.detail?.rollbackScope !== 'state_only') {
        push('rollback_scope_not_disclosed');
      }
    }
  }

  // 6. Checkpoint consistency
  if (!checkpointResult || !Array.isArray(checkpointResult.history) || checkpointResult.history.length === 0) {
    push('checkpoint_history_missing');
  } else if (snapshotResult.checkpointId && checkpointResult.checkpointId !== snapshotResult.checkpointId) {
    push('checkpoint_id_mismatch');
  }

  // 7. Secret hygiene: nothing resembling a credential may appear anywhere in the exposed record.
  const haystacks = [stringifyForSecretScan(snapshotResult), stringifyForSecretScan(auditResult), stringifyForSecretScan(checkpointResult)];
  for (const haystack of haystacks) {
    if (containsLikelySecret(haystack)) {
      push('secret_leak_detected');
      break;
    }
  }

  return { ok: violations.length === 0, violations };
}

module.exports = { verifyRouterRecord, REQUIRED_FIELDS, TERMINAL_STATUSES };
