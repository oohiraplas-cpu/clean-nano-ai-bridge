'use strict';
// Normalizes already-retrieved GitHub Actions job metadata for review.
// No network calls, credentials, writes, retries, or log contents.
function summarizeFailedCiJobs({ run, jobs } = {}) {
  const blocked = reason => Object.freeze({ status: 'blocked', reason, failedJobs: [], logJobIds: [], mayAutoRepair: false });
  if (!run || run.status !== 'completed' || !['failure','success'].includes(run.conclusion) ||
      !Array.isArray(jobs) || jobs.length === 0) return blocked('run_or_jobs_unverified');
  if (jobs.some(j => !j || !Number.isSafeInteger(j.id) || j.id <= 0 ||
      j.status !== 'completed' || typeof j.conclusion !== 'string')) return blocked('job_metadata_incomplete');
  const failed = jobs.filter(j => j.conclusion === 'failure');
  if (run.conclusion === 'success') {
    if (failed.length) return blocked('run_job_conclusion_mismatch');
    return Object.freeze({ status: 'success', failedJobs: [], logJobIds: [], mayAutoRepair: false });
  }
  if (failed.length !== 1 || jobs.some(j => !['success','failure','skipped'].includes(j.conclusion)))
    return blocked('failure_scope_ambiguous');
  const job = failed[0];
  if (typeof job.name !== 'string' || !job.name.trim() || job.name.length > 120) return blocked('failed_job_name_unverified');
  return Object.freeze({ status: 'needs_log_review', failedJobs: [job.name], logJobIds: [job.id], mayAutoRepair: false });
}
module.exports = { summarizeFailedCiJobs };
