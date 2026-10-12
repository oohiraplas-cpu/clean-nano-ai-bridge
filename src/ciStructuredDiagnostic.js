'use strict';
// Pure metadata-only validator. Artifact bytes must be fetched by a trusted caller.
// Never accepts logs, secrets, patches, or permissions as evidence.
const KEYS = Object.freeze({
  npm_test:'6. Run test suite',
  openapi_validation:'7. Validate OpenAPI',
  mcp_contract:'8. Validate MCP tool contract',
  safety_validation:'9. Validate canonical branch safety'
});
const outcomes = new Set(['success','failure','skipped','cancelled']);
const blocked = reason => Object.freeze({status:'blocked',reason,rootCauseVerified:false,mayEditDraft:false,mayMerge:false,mayDeploy:false});
function assessStructuredDiagnostic({diagnosticJson,workflowRun,jobResponse,artifact,expectedHeadSha,expectedRunAttempt} = {}) {
  if (typeof diagnosticJson !== 'string' || !diagnosticJson ||
      Buffer.byteLength(diagnosticJson,'utf8') > 4096) return blocked('diagnostic_invalid');
  let data;
  try { data = JSON.parse(diagnosticJson); } catch { return blocked('diagnostic_invalid'); }
  if (!data || Array.isArray(data) || typeof data !== 'object' ||
      Object.keys(data).sort().join(',') !==
      ['head_sha','job_key','run_attempt','run_id','schema_version','source','steps'].sort().join(',') ||
      data.schema_version !== 1 || data.source !== 'github_actions' ||
      data.job_key !== 'test') return blocked('diagnostic_schema_mismatch');
  if (!workflowRun || !Number.isSafeInteger(workflowRun.id) || workflowRun.id <= 0 ||
      !Number.isSafeInteger(workflowRun.run_attempt) || workflowRun.run_attempt <= 0 ||
      workflowRun.status !== 'completed' ||
      !['success','failure'].includes(workflowRun.conclusion) ||
      !/^[a-f0-9]{40}$/i.test(expectedHeadSha || '') ||
      workflowRun.head_sha !== expectedHeadSha ||
      !Number.isSafeInteger(expectedRunAttempt) || expectedRunAttempt <= 0 ||
      workflowRun.run_attempt !== expectedRunAttempt ||
      data.run_id !== workflowRun.id || data.run_attempt !== expectedRunAttempt ||
      data.head_sha !== expectedHeadSha) return blocked('diagnostic_provenance_mismatch');
  if (!artifact || !Number.isSafeInteger(artifact.id) || artifact.id <= 0 ||
      artifact.name !== 'ci-diagnostic-' + workflowRun.id + '-' + expectedRunAttempt ||
      artifact.expired !== false || artifact.workflow_run?.id !== workflowRun.id ||
      artifact.digest == null || typeof artifact.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/i.test(artifact.digest))
    return blocked('artifact_provenance_unverified');
  if (!jobResponse || jobResponse.total_count !== 1 ||
      !Array.isArray(jobResponse.jobs) || jobResponse.jobs.length !== 1)
    return blocked('job_scope_ambiguous');
  const job = jobResponse.jobs[0];
  if (!job || job.name !== 'test' || job.run_id !== workflowRun.id ||
      job.head_sha !== expectedHeadSha || job.status !== 'completed' ||
      !Array.isArray(job.steps)) return blocked('job_provenance_mismatch');
  if (!data.steps || typeof data.steps !== 'object' || Array.isArray(data.steps) ||
      Object.keys(data.steps).sort().join(',') !== Object.keys(KEYS).sort().join(',') ||
      Object.values(data.steps).some(x => !outcomes.has(x)))
    return blocked('step_schema_mismatch');
  for (const [key,name] of Object.entries(KEYS)) {
    const matching = job.steps.filter(s => s?.name === name);
    if (matching.length !== 1 || matching[0].conclusion !== data.steps[key])
      return blocked('step_outcome_mismatch');
  }
  const failed = Object.entries(data.steps).filter(([,value]) => value === 'failure');
  if ((workflowRun.conclusion === 'success' && failed.length !== 0) ||
      (workflowRun.conclusion === 'failure' && failed.length !== 1) ||
      (workflowRun.conclusion === 'success' && job.conclusion !== 'success') ||
      (workflowRun.conclusion === 'failure' && job.conclusion !== 'failure'))
    return blocked('failure_scope_ambiguous');
  return Object.freeze({
    status:failed.length ? 'review_required':'no_repair_needed',
    stepKey:failed.length ? failed[0][0] : null,
    rootCauseVerified:false,humanApprovalRequired:true,
    mayEditDraft:false,mayMerge:false,mayDeploy:false
  });
}
module.exports = {assessStructuredDiagnostic};
