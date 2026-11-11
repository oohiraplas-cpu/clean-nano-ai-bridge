'use strict';
// Pure CI remediation decision only. Never invokes GitHub writes, deployments, or retries.
const SHA = /^[a-f0-9]{40}$/i;
function assessCiAutoRepair({ branch, headSha, workflowEvent, conclusion, failedJobs, changedFiles, attempt = 0, evidence = {} } = {}) {
  const blocked = reason => Object.freeze({ status: 'blocked', reason, mayEditDraft: false, mayDeploy: false, mayMerge: false });
  if (branch !== 'draft/vnext-automation-gates-20261012' || !SHA.test(headSha || '')) return blocked('draft_target_unverified');
  if (!['push', 'pull_request'].includes(workflowEvent)) return blocked('event_unverified');
  if (conclusion === 'success') return Object.freeze({ status: 'no_repair_needed', mayEditDraft: false, mayDeploy: false, mayMerge: false });
  if (conclusion !== 'failure') return blocked('ci_not_failed');
  if (!Array.isArray(failedJobs) || failedJobs.length !== 1 || typeof failedJobs[0] !== 'string' || !failedJobs[0].trim()) return blocked('failure_scope_unverified');
  if (!Array.isArray(changedFiles) || changedFiles.length === 0 || changedFiles.length > 3 ||
      changedFiles.some(p => typeof p !== 'string' || !/^(src|test)\/[a-zA-Z0-9_./-]+\.(js|json)$/.test(p) || p.includes('..'))) return blocked('change_scope_unverified');
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= 2) return blocked('retry_limit_reached');
  if (evidence.failureLogReviewed !== true || evidence.rootCauseVerified !== true ||
      evidence.backupVerified !== true || evidence.diffReviewed !== true ||
      evidence.testPlanVerified !== true || evidence.humanApprovalForDraftEdit !== true) return blocked('repair_evidence_or_approval_missing');
  return Object.freeze({ status: 'draft_repair_candidate', mayEditDraft: true, mayDeploy: false, mayMerge: false, maxAttempts: 2 });
}
module.exports = { assessCiAutoRepair };
