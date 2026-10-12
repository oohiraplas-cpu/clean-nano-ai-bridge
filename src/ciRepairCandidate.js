'use strict';
// Pure bridge between GitHub Actions job metadata and the CI repair gate.
// No network calls, logs, credentials, writes, retries or deployment actions.
const { summarizeFailedCiJobs } = require('./ciFailureEvidence');
const { assessCiAutoRepair } = require('./ciAutoRepairGate');
function assessCiRepairCandidate({ run, jobs, branch, headSha, workflowEvent, changedFiles, attempt, evidence } = {}) {
  const summary = summarizeFailedCiJobs({ run, jobs });
  if (summary.status === 'blocked') return Object.freeze({ status: 'blocked', reason: summary.reason, logJobIds: [], mayEditDraft: false, mayDeploy: false, mayMerge: false });
  const gate = assessCiAutoRepair({
    branch, headSha, workflowEvent, conclusion: run.conclusion,
    failedJobs: summary.failedJobs, changedFiles, attempt, evidence
  });
  if (summary.status === 'success') return Object.freeze({
    status: gate.status, logJobIds: [], mayEditDraft: false, mayDeploy: false, mayMerge: false
  });
  return Object.freeze({
    status: gate.status, reason: gate.reason || null, logJobIds: summary.logJobIds,
    mayEditDraft: gate.mayEditDraft === true, mayDeploy: false, mayMerge: false
  });
}
module.exports = { assessCiRepairCandidate };
