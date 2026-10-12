'use strict';
// Read-only CI log review. The caller injects a GitHub job-log reader;
// no credentials, network client, writes, retries or deployments live here.
const { assessGitHubCiRepair } = require('./githubCiRepairAdapter');
const MAX_LOG_BYTES = 128 * 1024;
const blocked = reason => Object.freeze({status:'blocked',reason,mayEditDraft:false,mayDeploy:false,mayMerge:false});
const RULES = Object.freeze([
  ['test_failure', /(?:^|\n).*?(?:not ok \d+|AssertionError)/i],
  ['dependency_failure', /(?:npm ERR!|ERESOLVE)/i],
  ['build_failure', /(?:SyntaxError|Module not found)/i],
  ['permission_failure', /(?:403 Forbidden|permission denied)/i]
]);
function classifyFailure(log) {
  if (typeof log !== 'string' || !log.trim() ||
      Buffer.byteLength(log,'utf8') > MAX_LOG_BYTES)
    return Object.freeze({category:'unverified',reason:'invalid_log'});
  const matches = RULES.filter(([,pattern]) => pattern.test(log)).map(([name]) => name);
  if (matches.length !== 1)
    return Object.freeze({category:'unverified',reason:'ambiguous_or_unknown_failure'});
  return Object.freeze({category:matches[0],reason:'classification_only'});
}
async function reviewCiFailure({readJobLog,...input} = {}) {
  const gate = assessGitHubCiRepair(input);
  if (gate.status === 'no_repair_needed')
    return Object.freeze({status:'no_repair_needed',mayEditDraft:false,mayDeploy:false,mayMerge:false});
  // A verified failed job ID is necessary, but never sufficient, to authorize editing.
  if (!Array.isArray(gate.logJobIds) || gate.logJobIds.length !== 1 ||
      !Number.isSafeInteger(gate.logJobIds[0]) || gate.logJobIds[0] <= 0)
    return blocked('failed_job_unverified');
  if (typeof readJobLog !== 'function') return blocked('log_reader_unavailable');
  let log;
  try {
    log = await readJobLog(gate.logJobIds[0]);
  } catch {
    return blocked('log_fetch_failed');
  }
  const classification = classifyFailure(log);
  if (classification.category === 'unverified')
    return blocked(classification.reason);
  // Never expose raw logs, matched lines, credentials, or inferred file paths.
  // The candidate is for human investigation, not an executable patch.
  return Object.freeze({
    status:'review_required',
    jobId:gate.logJobIds[0],
    candidate:Object.freeze({category:classification.category,action:'investigate_and_propose_minimal_diff'}),
    rootCauseVerified:false,
    humanApprovalRequired:true,
    mayEditDraft:false,mayDeploy:false,mayMerge:false
  });
}
module.exports = { classifyFailure, reviewCiFailure };
