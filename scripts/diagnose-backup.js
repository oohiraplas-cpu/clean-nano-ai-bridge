'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { getConfig } = require('../src/config');

const EXPECTED = Object.freeze({
  appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
  environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
  solution: 'CN_AIIraiDaicho',
  artifact: 'CN_AIIraiDaicho-unmanaged-backup'
});
function checkTarget(env) {
  const c = getConfig(env).powerApps;
  return [
    ['POWERAPPS_APP_ID', c.appId === EXPECTED.appId],
    ['POWERAPPS_ENVIRONMENT_ID', c.environmentId === EXPECTED.environmentId],
    ['POWERAPPS_SOLUTION_UNIQUE_NAME', c.solutionUniqueName === EXPECTED.solution]
  ].map(([name, ok]) => ({ check: name, status: ok ? 'pass' : 'fail' }));
}
function checkArtifact(a, now = new Date()) {
  const digest = /^sha256:[a-f0-9]{64}$/i.test(a?.digest || '');
  return {
    name: a?.name || null,
    status: a?.name === EXPECTED.artifact && a?.expired === false &&
      Number(a?.size_in_bytes) > 0 && digest && Date.parse(a?.expires_at) > now.getTime()
      ? 'pass' : 'fail',
    expiresAt: a?.expires_at || null,
    sizeBytes: a?.size_in_bytes || 0,
    digestValid: digest
  };
}
async function getBackup(runId, token, fetchImpl = fetch) {
  if (!/^\d+$/.test(String(runId))) throw Error('BACKUP_RUN_ID must be numeric');
  if (!token) throw Error('GITHUB_TOKEN is required for private backup verification');
  const response = await fetchImpl(
    `https://api.github.com/repos/oohiraplas-cpu/clean-nano-ai-bridge/actions/runs/${runId}/artifacts?per_page=100`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } }
  );
  if (!response.ok) throw Error(`GitHub artifacts lookup failed: HTTP ${response.status}`);
  const json = await response.json();
  return (json.artifacts || []).find(a => a.name === EXPECTED.artifact) || null;
}
async function run(env = process.env) {
  const target = checkTarget(env);
  let backup = { status: 'not_checked', reason: 'BACKUP_RUN_ID not provided' };
  if (env.BACKUP_RUN_ID) {
    try { backup = checkArtifact(await getBackup(env.BACKUP_RUN_ID, env.GITHUB_TOKEN)); }
    catch (e) { backup = { status: 'fail', reason: e.message }; }
  }
  const result = {
    generatedAt: new Date().toISOString(), mode: 'read_only', target,
    backup, overall: target.every(x => x.status === 'pass') && backup.status === 'pass' ? 'pass' : 'fail'
  };
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## Bridge diagnostics + backup verification\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.overall !== 'pass') process.exitCode = 1;
  return result;
}
if (require.main === module) run().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { EXPECTED, checkTarget, checkArtifact, getBackup, run };
