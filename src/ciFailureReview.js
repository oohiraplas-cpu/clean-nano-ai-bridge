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
function extractFailedStep(log, steps) {
  if (typeof log !== 'string' || !Array.isArray(steps) || steps.length === 0)
    return Object.freeze({status:'blocked',reason:'step_metadata_missing'});
  const failed = steps.filter(s => s && s.conclusion === 'failure');
  if (failed.length !== 1 || steps.some(s => !s || !Number.isSafeInteger(s.number) ||
      typeof s.started_at !== 'string' || typeof s.completed_at !== 'string'))
    return Object.freeze({status:'blocked',reason:'step_metadata_ambiguous'});
  const intervals = steps.map(s => ({
    start: Date.parse(s.started_at), end: Date.parse(s.completed_at)
  }));
  if (intervals.some(x => !Number.isFinite(x.start) || !Number.isFinite(x.end) || x.end < x.start))
    return Object.freeze({status:'blocked',reason:'step_time_invalid'});
  const index = steps.indexOf(failed[0]);
  const target = intervals[index];
  if (intervals.some((x,i) => i !== index && x.start <= target.end && x.end >= target.start))
    return Object.freeze({status:'blocked',reason:'step_time_overlap'});
  const lines = log.split(/\r?\n/);
  const selected = [];
  let previous = -Infinity, first = -1, last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && lines[i] === '') continue;
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s/.exec(lines[i]);
    if (!m) return Object.freeze({status:'blocked',reason:'log_timestamp_missing'});
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t) || t < previous)
      return Object.freeze({status:'blocked',reason:'log_timestamp_invalid'});
    previous = t;
    if (t >= target.start && t <= target.end) {
      if (first < 0) first = i;
      last = i;
      selected.push(lines[i]);
    }
  }
  if (first < 0 || selected.length !== last - first + 1)
    return Object.freeze({status:'blocked',reason:'step_boundary_ambiguous'});
  const excerpt = selected.join('\n');
  if (Buffer.byteLength(excerpt,'utf8') > MAX_LOG_BYTES)
    return Object.freeze({status:'blocked',reason:'step_log_oversize'});
  return {status:'ok',excerpt};
}
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
  const failedJob = input.jobResponse?.jobs?.find(j => j.id === gate.logJobIds[0]);
  const extraction = extractFailedStep(log, failedJob?.steps);
  if (extraction.status !== 'ok') return blocked(extraction.reason);
  const classification = classifyFailure(extraction.excerpt);
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
module.exports = { classifyFailure, extractFailedStep, reviewCiFailure };
