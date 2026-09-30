const assert = require('node:assert/strict');
const test = require('node:test');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');

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
    orgUrl: 'https://example.crm.dynamics.com', solutionUniqueName: 'CN_CompanyOS',
    githubToken: 'github-token', githubOwner: 'owner', githubRepo: 'repo',
    githubBranch: 'main', githubRoot: 'powerapps/app/Source', fetchImpl
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

test('同期先ソリューション未設定ならGitHub更新前に止まる', async () => {
  const calls = [];
  const store = new PowerAppsGitStore({
    tenantId: 'tenant', clientId: 'client', clientSecret: 'secret',
    orgUrl: 'https://example.crm.dynamics.com',
    githubToken: 'github-token', githubOwner: 'owner', githubRepo: 'repo',
    fetchImpl: async (url) => { calls.push(url); throw new Error('unexpected upstream'); }
  });
  await assert.rejects(store.applySourceFileChange('App.pa.yaml', 'new'), /POWERAPPS_SOLUTION_UNIQUE_NAME/);
  assert.deepEqual(calls, []);
});
