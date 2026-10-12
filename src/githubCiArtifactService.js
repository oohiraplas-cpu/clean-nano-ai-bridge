'use strict';
const { verifyCiArtifactZip } = require('./ciArtifactReader');
const { assessStructuredDiagnostic } = require('./ciStructuredDiagnostic');

const REPOSITORY = 'oohiraplas-cpu/clean-nano-ai-bridge';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const blocked = reason => ({ status: 'blocked', reason, mayEditDraft: false, mayMerge: false, mayDeploy: false });
const fields = ['runId', 'artifactId', 'expectedHeadSha', 'expectedRunAttempt'];
function validInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === fields.length && fields.every(key => Object.hasOwn(input, key)) &&
    ['runId', 'artifactId', 'expectedRunAttempt'].every(key => Number.isSafeInteger(input[key]) && input[key] > 0) &&
    typeof input.expectedHeadSha === 'string' && /^[a-f0-9]{40}$/.test(input.expectedHeadSha);
}
async function boundedBytes(response, limit) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw Error('body_limit');
  const reader = response.body.getReader();
  const parts = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('body_limit');
      parts.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
function safeDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['.blob.core.windows.net', '.actions.githubusercontent.com'].some(suffix => url.hostname.endsWith(suffix)))
    throw Error('download_host');
  return url.href;
}
function createGitHubCiArtifactService(config = {}, fetchImpl = config.fetchImpl || fetch) {
  // Reuse the existing Actions credential; never fall back to Power Apps source credentials.
  const token = config.githubToken;
  return {
    async verify(input) {
      if (!validInput(input)) return blocked('ci_artifact_input_invalid');
      if (!token || `${config.githubOwner}/${config.githubRepo}` !== REPOSITORY)
        return blocked('github_ci_reader_unavailable');
      const signal = AbortSignal.timeout(15000);
      const headers = {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28'};
      async function api(path) {
        const response = await fetchImpl(API + path, {method: 'GET', headers, redirect: 'error', signal});
        if (!response.ok) throw Error('github_read_failed');
        return JSON.parse((await boundedBytes(response, 1048576)).toString('utf8'));
      }
      const {runId, artifactId, expectedHeadSha, expectedRunAttempt} = input;
      function runMatches(run) {
        return run.id === runId && run.repository?.full_name === REPOSITORY &&
          run.head_sha === expectedHeadSha && run.run_attempt === expectedRunAttempt &&
          run.status === 'completed' && ['success', 'failure'].includes(run.conclusion);
      }
      try {
        const run = await api(`/actions/runs/${runId}`);
        if (!runMatches(run)) return blocked('workflow_provenance_mismatch');
        const artifact = await api(`/actions/artifacts/${artifactId}`);
        if (artifact.id !== artifactId || artifact.workflow_run?.id !== runId ||
            artifact.workflow_run?.head_sha !== expectedHeadSha || artifact.expired !== false ||
            artifact.name !== `ci-diagnostic-${runId}-${expectedRunAttempt}` ||
            !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 22 || artifact.size_in_bytes > 65536)
          return blocked('artifact_provenance_unverified');
        const jobs = await api(`/actions/runs/${runId}/attempts/${expectedRunAttempt}/jobs?per_page=100`);
        // Preserve total_count and job.head_sha from REST; never synthesize missing evidence.
        const redirect = await fetchImpl(API + `/actions/artifacts/${artifactId}/zip`,
          {method: 'GET', headers, redirect: 'manual', signal});
        let zip;
        if (redirect.status === 302) {
          const url = safeDownloadUrl(redirect.headers.get('location'));
          const response = await fetchImpl(url, {method: 'GET', redirect: 'error', signal});
          if (!response.ok) throw Error('download_failed');
          zip = await boundedBytes(response, 65536);
        } else if (redirect.status === 200) {
          zip = await boundedBytes(redirect, 65536);
        } else throw Error('download_failed');
        if (zip.length !== artifact.size_in_bytes) return blocked('artifact_size_mismatch');
        const checked = verifyCiArtifactZip({zipBytes: zip, artifact});
        if (checked.status !== 'ok') return checked;
        const result = assessStructuredDiagnostic({diagnosticJson: checked.diagnosticJson,
          workflowRun: run, jobResponse: jobs, artifact, expectedHeadSha, expectedRunAttempt});
        if (result.status === 'blocked') return result;
        const current = await api(`/actions/runs/${runId}`);
        if (!runMatches(current) || current.conclusion !== run.conclusion) return blocked('workflow_changed_during_read');
        return {...result, verifiedArtifact: {runId, artifactId, headSha: expectedHeadSha,
          runAttempt: expectedRunAttempt, digest: artifact.digest}};
      } catch {
        // Do not echo upstream bodies, tokens, redirect URLs, or logs.
        return blocked('github_ci_read_failed');
      }
    }
  };
}
module.exports = {createGitHubCiArtifactService};
