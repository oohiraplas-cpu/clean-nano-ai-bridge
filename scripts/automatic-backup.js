'use strict';
// Orchestrates the existing read-only export workflow. Never imports or publishes.
const { EXPECTED, checkArtifact } = require('./diagnose-backup');
const REPO = 'oohiraplas-cpu/clean-nano-ai-bridge';
const WORKFLOW = 'cn-aiiraidaicho-backup-manual.yml';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function github(path, token, options = {}, fetchImpl = fetch) {
  if (!token) throw Error('GITHUB_TOKEN missing');
  const res = await fetchImpl('https://api.github.com/repos/' + REPO + path, {
    ...options,
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', ...(options.headers || {}) }
  });
  if (!res.ok) throw Error('GitHub request failed: HTTP ' + res.status);
  return res.status === 204 ? null : res.json();
}
async function run(token, { fetchImpl = fetch, sleepImpl = sleep, now = () => Date.now(), maxPolls = 45 } = {}) {
  const started = now();
  const ref = 'main'; // Existing reviewed manual export workflow, never the feature branch.
  await github('/actions/workflows/' + WORKFLOW + '/dispatches', token,
    { method: 'POST', body: JSON.stringify({ ref }) }, fetchImpl);
  let selected;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const response = await github('/actions/workflows/' + WORKFLOW + '/runs?event=workflow_dispatch&branch=main&per_page=30',
      token, {}, fetchImpl);
    const candidates = (response.workflow_runs || []).filter(x =>
      Date.parse(x.created_at) >= started - 10000 && x.head_branch === ref);
    // Concurrent runs are ambiguous: fail closed rather than verifying someone else's backup.
    if (candidates.length > 1) throw Error('Ambiguous concurrent backup runs: manual review required');
    if (candidates.length === 1) {
      selected = candidates[0];
      if (selected.status === 'completed') break;
    }
    await sleepImpl(20000);
  }
  if (!selected || selected.status !== 'completed' || selected.conclusion !== 'success')
    throw Error('Backup run not completed successfully within polling window');
  const response = await github('/actions/runs/' + selected.id + '/artifacts?per_page=100', token, {}, fetchImpl);
  const artifact = (response.artifacts || []).find(x => x.name === EXPECTED.artifact);
  const verified = checkArtifact(artifact, new Date(now()));
  if (verified.status !== 'pass') throw Error('Backup artifact metadata verification failed');
  return { status: 'pass', workflowRunId: selected.id, artifactId: artifact.id,
    expiresAt: verified.expiresAt, digest: artifact.digest, note: 'Artifact metadata verified; restore test is separate' };
}
if (require.main === module) {
  run(process.env.GITHUB_TOKEN).then(x => console.log(JSON.stringify(x, null, 2)))
    .catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { run, github };
