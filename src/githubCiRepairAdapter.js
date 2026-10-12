'use strict';
// Read-only adapter for already-fetched GitHub Actions metadata.
// Does not fetch logs, use credentials, or execute repair/write operations.
const { assessCiRepairCandidate } = require('./ciRepairCandidate');
const SHA = /^[a-f0-9]{40}$/i;
function assessGitHubCiRepair({ workflowRun, jobResponse, expectedHeadSha, branch, changedFiles, attempt, evidence } = {}) {
  const blocked = reason => Object.freeze({ status: 'blocked', reason, logJobIds: [], mayEditDraft: false, mayDeploy: false, mayMerge: false });
  if (!workflowRun || !SHA.test(expectedHeadSha || '') ||
      workflowRun.head_sha !== expectedHeadSha ||
      workflowRun.head_branch !== branch ||
      !['pull_request','push'].includes(workflowRun.event)) return blocked('workflow_identity_unverified');
  if (!jobResponse || !Array.isArray(jobResponse.jobs) || jobResponse.jobs.length === 0 ||
      jobResponse.total_count !== undefined && jobResponse.total_count !== jobResponse.jobs.length)
    return blocked('job_page_incomplete');
  if (jobResponse.jobs.some(j => !j || j.head_sha && j.head_sha !== expectedHeadSha ||
      j.run_id !== undefined && j.run_id !== workflowRun.id))
    return blocked('job_provenance_mismatch');
  return assessCiRepairCandidate({
    run: { status: workflowRun.status, conclusion: workflowRun.conclusion },
    jobs: jobResponse.jobs.map(j => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion })),
    branch, headSha: expectedHeadSha, workflowEvent: workflowRun.event,
    changedFiles, attempt, evidence
  });
}
module.exports = { assessGitHubCiRepair };
