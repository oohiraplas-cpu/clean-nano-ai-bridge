'use strict';
// Pure read-only adapter. The caller provides GitHub's job-log reader.
// No GitHub credentials, writes, reruns, merge or deployment operations.
const { reviewCiFailure } = require('./ciFailureReview');
const { assessStructuredDiagnostic } = require('./ciStructuredDiagnostic');
const { verifyCiArtifactZip } = require('./ciArtifactReader');
const blocked = reason => Object.freeze({status:'blocked',reason,mayEditDraft:false,mayDeploy:false,mayMerge:false});
async function reviewGitHubCiFailure({github,repositoryFullName,...input} = {}) {
  if (typeof repositoryFullName !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName) ||
      repositoryFullName !== 'oohiraplas-cpu/clean-nano-ai-bridge')
    return blocked('repository_unverified');
  if (!github || typeof github.fetch_workflow_job_logs !== 'function')
    return blocked('github_log_reader_unavailable');
  // reviewCiFailure verifies run/head/branch/event, full job count, step metadata and
  // failed job identity BEFORE invoking this reader.
  return reviewCiFailure({
    ...input,
    readJobLog: async jobId => {
      const response = await github.fetch_workflow_job_logs({
        repo_full_name: repositoryFullName, job_id: jobId
      });
      if (!response || !response.result ||
          typeof response.result.content !== 'string')
        throw new Error('invalid_log_response');
      return response.result.content;
    }
  });
}
// Caller must independently verify artifact download and digest before supplying JSON.
// This function cannot establish authenticity of arbitrary caller-provided bytes.
function reviewGitHubStructuredDiagnostic(input = {}) {
  return assessStructuredDiagnostic(input);
}
// ZIP bytes are supplied by an authenticated, read-only caller. No network or file writes.
function reviewGitHubStructuredArtifact({zipBytes,...input} = {}) {
  if (input.repositoryFullName !== 'oohiraplas-cpu/clean-nano-ai-bridge')
    return blocked('repository_unverified');
  const checked = verifyCiArtifactZip({zipBytes,artifact:input.artifact});
  if (checked.status !== 'ok') return checked;
  return assessStructuredDiagnostic({...input,diagnosticJson:checked.diagnosticJson});
}
module.exports = { reviewGitHubCiFailure, reviewGitHubStructuredDiagnostic, reviewGitHubStructuredArtifact };
