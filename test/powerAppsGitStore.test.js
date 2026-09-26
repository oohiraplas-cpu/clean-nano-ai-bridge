const assert = require('node:assert/strict');
const test = require('node:test');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');
const { CN_AI_TARGET } = require('../src/config');

test('Power Appsソース更新後にPower Platformへ同期する', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.includes('api.github.com') && (options.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({
        type: 'file', sha: 'old-sha', content: Buffer.from('old').toString('base64')
      }), { status: 200 });
    }
    if (url.includes('api.github.com') && options.method === 'PUT') {
      return new Response(JSON.stringify({
        commit: { sha: 'commit-sha' }, content: { sha: 'content-sha' }
      }), { status: 200 });
    }
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith('/RefreshChangesFromGit')) {
      return new Response(JSON.stringify({ refreshed: true }), { status: 200 });
    }
    if (url.endsWith('/PullChangesFromGit')) {
      return new Response(JSON.stringify({ pulled: true }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  const store = new PowerAppsGitStore({
    tenantId: 'tenant', clientId: 'client', clientSecret: 'secret',
    orgUrl: CN_AI_TARGET.orgUrl, solutionUniqueName: CN_AI_TARGET.solutionUniqueName,
    appId: CN_AI_TARGET.appId, environmentId: CN_AI_TARGET.environmentId,
    githubToken: 'github-token', githubOwner: 'owner', githubRepo: 'repo',
    githubBranch: 'main', githubRoot: CN_AI_TARGET.githubRoot, fetchImpl
  });

  const result = await store.applySourceFileChange('App.pa.yaml', 'new', 'sync source');

  assert.equal(result.status, 'ok');
  assert.equal(result.update.commitSha, 'commit-sha');
  assert.equal(result.refresh.action, 'RefreshChangesFromGit');
  assert.equal(result.pull.action, 'PullChangesFromGit');
  assert.deepEqual(
    calls.filter(({ url }) => url.includes('api/data/v9.2')).map(({ url }) => url.split('/').pop()),
    ['RefreshChangesFromGit', 'PullChangesFromGit']
  );
});

test('mismatched target blocks source write before any network call', async () => {
  let calls = 0;
  const store = new PowerAppsGitStore({
    appId: 'wrong-app', environmentId: CN_AI_TARGET.environmentId,
    orgUrl: CN_AI_TARGET.orgUrl, solutionUniqueName: CN_AI_TARGET.solutionUniqueName,
    githubRoot: CN_AI_TARGET.githubRoot,
    fetchImpl: async () => { calls++; throw new Error('must not call network'); }
  });
  await assert.rejects(store.updateSourceFile('App.pa.yaml', 'changed'), /CN_AI target mismatch/);
  await assert.rejects(store.refreshFromGit(), /CN_AI target mismatch/);
  await assert.rejects(store.pullFromGit(), /CN_AI target mismatch/);
  assert.equal(calls, 0);
});
