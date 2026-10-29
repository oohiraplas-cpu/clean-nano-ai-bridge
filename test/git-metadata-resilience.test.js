const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');

const sha = 'a'.repeat(40);
function makeStore(handler) {
  const store = new PowerAppsGitStore({
    githubToken: 'test-token', githubOwner: 'owner', githubRepo: 'repo',
    githubBranch: 'main', githubRoot: 'powerapps/Source'
  });
  store._githubRequest = handler;
  return store;
}
test('canonical commit and root are verified', async () => {
  const calls = [];
  const store = makeStore(async path => {
    calls.push(path);
    if (path.includes('/git/ref/')) return { object: { type: 'commit', sha } };
    return [{ type: 'file', name: 'S1_Home.pa.yaml' }];
  });
  assert.deepEqual(await store.getSourceFileMetadata('powerapps/Source'), {
    branch: 'main', canonicalBranch: 'main', sha
  });
  assert.match(calls[1], new RegExp('ref=' + sha));
});
test('root mismatch fails closed before network', async () => {
  const store = makeStore(async () => { throw Error('unexpected request'); });
  await assert.rejects(store.getSourceFileMetadata('other'), /root mismatch/);
});
test('canonical ref failure never falls back to stale branches', async () => {
  const calls = [];
  const store = makeStore(async path => {
    calls.push(path);
    throw Error('GitHub API エラー (404)');
  });
  await assert.rejects(store.getSourceFileMetadata('powerapps/Source'),
    error => error.payload.status === 'git_ref_not_found');
  assert.equal(calls.length, 1);
});
test('401, 403, 429 and 500 are explicitly classified', async () => {
  for (const [status, expected] of [[401,'git_auth_or_permission'],[403,'git_auth_or_permission'],[429,'git_rate_limited'],[500,'git_upstream_failure']]) {
    const store = makeStore(async () => { throw Error('GitHub API エラー (' + status + ')'); });
    await assert.rejects(store.getSourceFileMetadata('powerapps/Source'),
      error => error.payload.status === expected);
  }
});
test('non-commit ref and absent root are rejected', async () => {
  const store = makeStore(async path => path.includes('/git/ref/')
    ? { object: { type: 'tree', sha } } : []);
  await assert.rejects(store.getSourceFileMetadata('powerapps/Source'), /not a commit/);
  const missing = makeStore(async path => path.includes('/git/ref/')
    ? { object: { type: 'commit', sha } } : { type: 'file' });
  await assert.rejects(missing.getSourceFileMetadata('powerapps/Source'), /root unavailable/);
});
