'use strict';

// Pure preflight gate for vNext proposals. This module never executes a write.
// Unknown evidence must never be treated as a successful check.
const WRITE_OPERATIONS = new Set(['create', 'update', 'save', 'publish', 'enable', 'deploy', 'delete', 'permission_change']);
const HIGH_RISK_OPERATIONS = new Set(['publish', 'enable', 'deploy', 'delete', 'permission_change']);

function assessAutomationProposal(proposal = {}, evidence = {}) {
  const failures = [];
  const operation = typeof proposal.operation === 'string' ? proposal.operation : '';
  const platform = typeof proposal.platform === 'string' ? proposal.platform : '';
  if (!['powerapps', 'powerautomate', 'sharepoint', 'dataverse', 'copilotstudio', 'solutions', 'bridge'].includes(platform)) failures.push('platform_unknown');
  if (!['read', 'inspect', ...WRITE_OPERATIONS].includes(operation)) failures.push('operation_unknown');
  if (proposal.additionalCost === true) failures.push('additional_cost_forbidden');
  if (proposal.permissionExpansion === true) failures.push('permission_expansion_forbidden');
  if (proposal.destructive === true) failures.push('destructive_change_forbidden');
  if (proposal.targetBranch === 'main' && WRITE_OPERATIONS.has(operation)) failures.push('main_write_forbidden');
  if (WRITE_OPERATIONS.has(operation) && evidence.backupVerified !== true) failures.push('backup_unverified');
  if (WRITE_OPERATIONS.has(operation) && evidence.diffReviewed !== true) failures.push('diff_unreviewed');
  if (WRITE_OPERATIONS.has(operation) && evidence.ciPassed !== true) failures.push('ci_unverified');
  if (platform === 'powerapps' && WRITE_OPERATIONS.has(operation) && evidence.appCheckerCriticalZero !== true) failures.push('app_checker_unverified');
  if (platform === 'powerautomate' && WRITE_OPERATIONS.has(operation) && evidence.triggerSafetyVerified !== true) failures.push('flow_trigger_unverified');
  if (HIGH_RISK_OPERATIONS.has(operation)) {
    if (evidence.humanApprovalVerified !== true) failures.push('human_approval_unverified');
    if (evidence.rollbackVerified !== true) failures.push('rollback_unverified');
  }
  return Object.freeze({ allowed: failures.length === 0, failures });
}

module.exports = { assessAutomationProposal };
