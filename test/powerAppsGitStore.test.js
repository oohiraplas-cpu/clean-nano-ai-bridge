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
    if (url.includes('/solutions?')) {
      return new Response(JSON.stringify({ value: [{ uniquename: 'ActualSolution', friendlyname: 'Actual Solution' }] }), { status: 200 });
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
  assert.equal(result.sync.refresh.action, 'RefreshChangesFromGit');
  assert.equal(result.sync.pull.action, 'PullChangesFromGit');
  assert.deepEqual(
    calls.filter(({ url }) => url.endsWith('/RefreshChangesFromGit') || url.endsWith('/PullChangesFromGit')).map(({ url }) => url.split('/').pop()),
    ['RefreshChangesFromGit', 'PullChangesFromGit']
  );
});

test('Git統合されていないSolutionでもGitHubソース更新を失わない', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.includes('api.github.com') && (options.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({ type: 'file', sha: 'old-sha', content: Buffer.from('old').toString('base64') }), { status: 200 });
    }
    if (url.includes('api.github.com') && options.method === 'PUT') {
      return new Response(JSON.stringify({ commit: { sha: 'commit-sha' }, content: { sha: 'content-sha' } }), { status: 200 });
    }
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('/solutions?')) {
      return new Response(JSON.stringify({ value: [{ uniquename: 'ActualSolution', friendlyname: 'Actual Solution' }] }), { status: 200 });
    }
    if (url.endsWith('/RefreshChangesFromGit')) return new Response('{}', { status: 200 });
    if (url.endsWith('/PullChangesFromGit')) {
      return new Response(JSON.stringify({ error: { code: '0x80040216', message: 'Not a valid solution' } }), { status: 400 });
    }
    return new Response('not found', { status: 404 });
  };
  const store = new PowerAppsGitStore({
    tenantId: 'tenant', clientId: 'client', clientSecret: 'secret',
    orgUrl: 'https://example.crm.dynamics.com', solutionUniqueName: 'ActualSolution',
    githubToken: 'github-token', githubOwner: 'owner', githubRepo: 'repo',
    githubBranch: 'main', githubRoot: 'powerapps/app/Source', fetchImpl
  });
  const result = await store.applySourceFileChange('App.pa.yaml', 'new', 'sync source');
  assert.equal(result.status, 'ok');
  assert.equal(result.update.commitSha, 'commit-sha');
  assert.equal(result.sync.status, 'skipped');
  assert.equal(result.sync.reason, 'solution_not_git_integrated');
});

// ---- 正本branch保護（過去branchへの誤書き込み防止） ----

const FALLBACK = 'sync/cn-aiiraidaicho-live-review-20260926';

/** branchごとのファイル内容を持つGitHub Contents APIモック。呼び出しを記録する。 */
function createGitHubMock(branches) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes('api.github.com') && method === 'GET') {
      const parsed = new URL(url);
      const ref = parsed.searchParams.get('ref');
      const filePath = decodeURIComponent(parsed.pathname.split('/contents/')[1]);
      const content = branches[ref]?.[filePath];
      if (content === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return new Response(JSON.stringify({ type: 'file', sha: `sha-${ref}`, content: Buffer.from(content).toString('base64') }), { status: 200 });
    }
    if (url.includes('api.github.com') && method === 'PUT') {
      return new Response(JSON.stringify({ commit: { sha: 'commit-sha' }, content: { sha: 'content-sha' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, value: [{ uniquename: 'S' }], access_token: 't', expires_in: 3600 }), { status: 200 });
  };
  return { calls, fetchImpl };
}

function createStore(fetchImpl, overrides = {}) {
  return new PowerAppsGitStore({
    tenantId: 'tenant', clientId: 'client', clientSecret: 'secret',
    orgUrl: 'https://example.crm.dynamics.com', solutionUniqueName: 'CN_CompanyOS',
    githubToken: 'github-token', githubOwner: 'owner', githubRepo: 'repo',
    githubBranch: 'main', githubRoot: 'powerapps/app/Source', fetchImpl, ...overrides
  });
}

test('フォールバック先（過去branch）でのみ見つかったソースは更新を拒否し、PUTを送らない', async () => {
  const github = createGitHubMock({ [FALLBACK]: { 'powerapps/app/Source/Screen3.pa.yaml': 'old content' } });
  const store = createStore(github.fetchImpl);

  await assert.rejects(
    store.updateSourceFile('Screen3.pa.yaml', 'new content', 'msg'),
    (error) => error.status === 409
      && error.payload.status === 'branch_mismatch'
      && error.payload.canonicalBranch === 'main'
      && error.message.includes(FALLBACK)
      && error.message.includes('main')
  );
  assert.equal(github.calls.filter((call) => call.method === 'PUT').length, 0, '過去branchへPUTしてはならない');
});

test('applySourceFileChangeも過去branchでは更新・Power Platform同期のいずれも実行しない', async () => {
  const github = createGitHubMock({ [FALLBACK]: { 'powerapps/app/Source/Screen3.pa.yaml': 'old content' } });
  const store = createStore(github.fetchImpl);
  await assert.rejects(store.applySourceFileChange('Screen3.pa.yaml', 'new', 'msg'), (error) => error.status === 409);
  assert.deepEqual(
    github.calls.filter((call) => call.method !== 'GET' || !call.url.includes('api.github.com')),
    [],
    'PUTもDataverse/OAuth呼び出しも発生しない'
  );
});

test('正本branchでソースが見つかれば、そのbranchへ更新する', async () => {
  const github = createGitHubMock({ main: { 'powerapps/app/Source/Screen3.pa.yaml': 'old' }, [FALLBACK]: { 'powerapps/app/Source/Screen3.pa.yaml': 'older' } });
  const store = createStore(github.fetchImpl);
  const result = await store.updateSourceFile('Screen3.pa.yaml', 'new', 'msg');
  assert.equal(result.branch, 'main');
  const put = github.calls.find((call) => call.method === 'PUT');
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.sha, 'sha-main');
});

test('getSourceFileは取得したbranchと正本branchの一致状況を返す', async () => {
  const fallbackOnly = createStore(createGitHubMock({ [FALLBACK]: { 'powerapps/app/Source/A.pa.yaml': 'x' } }).fetchImpl);
  const fromFallback = await fallbackOnly.getSourceFile('A.pa.yaml');
  assert.equal(fromFallback.branch, FALLBACK);
  assert.equal(fromFallback.canonicalBranch, 'main');
  assert.equal(fromFallback.isCanonicalBranch, false);

  const canonical = createStore(createGitHubMock({ main: { 'powerapps/app/Source/A.pa.yaml': 'x' } }).fetchImpl);
  const fromMain = await canonical.getSourceFile('A.pa.yaml');
  assert.equal(fromMain.isCanonicalBranch, true);
});

test('呼び出し側が把握しているbranchが正本と異なる場合は、通信前に更新を拒否する', async () => {
  const github = createGitHubMock({ main: { 'powerapps/app/Source/A.pa.yaml': 'x' } });
  const store = createStore(github.fetchImpl);
  await assert.rejects(store.updateSourceFile('A.pa.yaml', 'y', 'msg', FALLBACK), (error) => error.status === 409 && error.payload.status === 'branch_mismatch');
  assert.equal(github.calls.length, 0);
});

test('assertCanonicalBranch: 未指定は後方互換でスキップ、一致は通過、不一致は保存・公開も拒否する', () => {
  const store = createStore(async () => new Response('{}'));
  assert.deepEqual(store.assertCanonicalBranch(undefined, '保存'), { checked: false });
  assert.deepEqual(store.assertCanonicalBranch('main', '公開'), { checked: true, branch: 'main' });
  assert.throws(() => store.assertCanonicalBranch(FALLBACK, '保存'), (error) => error.status === 409 && error.message.includes('保存を拒否'));
  assert.throws(() => store.assertCanonicalBranch('feature/x', '公開'), (error) => error.status === 409 && error.message.includes('公開を拒否'));
});
