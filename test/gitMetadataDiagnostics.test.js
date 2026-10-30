const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');

const sha = 'a'.repeat(40);
function store(fetchImpl, branches = []) {
  return new PowerAppsGitStore({
    githubToken: 'test-token', githubOwner: 'example', githubRepo: 'repo',
    githubBranch: 'main', githubFallbackBranches: branches, fetchImpl
  });
}

test('Git metadata: successful canonical commit SHA', async () => {
  const git = store(async () => ({ ok: true, json: async () => ({ object: { sha } }) }));
  assert.deepEqual(await git.getSourceFileMetadata('ignored'), {
    branch: 'main', canonicalBranch: 'main', sha
  });
});

test('Git metadata: authentication error is categorized and does not expose response body', async () => {
  const git = store(async () => ({ ok: false, status: 401, text: async () => 'secret response body' }));
  await assert.rejects(git.getSourceFileMetadata('ignored'), err => {
    assert.equal(err.status, 502);
    assert.equal(err.payload.status, 'state_context_invalid');
    assert.ok(err.payload.failures.some(f => f.branch === 'main' && f.status === 401 && f.category === 'authentication'));
    assert.ok(!JSON.stringify(err).includes('secret response body'));
    return true;
  });
});

test('Git metadata: permission, missing branch and rate limit are categorized', async () => {
  for (const [status, category] of [[403, 'permission_or_rate_limit'], [404, 'branch_not_found'], [429, 'rate_limit'], [503, 'upstream']]) {
    const git = store(async () => ({ ok: false, status, text: async () => 'sensitive' }));
    await assert.rejects(git.getSourceFileMetadata('ignored'), err => {
      assert.ok(err.payload.failures.some(f => f.status === status && f.category === category));
      return true;
    });
  }
});

test('Git metadata: invalid commit SHA never establishes authority', async () => {
  const git = store(async () => ({ ok: true, json: async () => ({ object: { sha: 'not-a-commit' } }) }));
  await assert.rejects(git.getSourceFileMetadata('ignored'), /no valid commit SHA retrieved/);
});

test('Git metadata: fallback success is READ metadata only, canonical remains main', async () => {
  const git = store(async url => url.includes('/heads/main')
    ? { ok: false, status: 404, text: async () => '' }
    : { ok: true, json: async () => ({ object: { sha } }) }, ['repair']);
  const metadata = await git.getSourceFileMetadata('ignored');
  assert.equal(metadata.branch, 'repair');
  assert.equal(metadata.canonicalBranch, 'main');
});

test('Git metadata: missing token is fail-closed', async () => {
  const git = new PowerAppsGitStore({ githubOwner: 'example', githubRepo: 'repo', githubBranch: 'main' });
  await assert.rejects(git.getSourceFileMetadata('ignored'), err => {
    assert.equal(err.payload.status, 'AUTH_CONFIGURATION');
    assert.ok(err.payload.missingConfiguration.includes('POWERAPPS_GITHUB_TOKEN'));
    return true;
  });
});
