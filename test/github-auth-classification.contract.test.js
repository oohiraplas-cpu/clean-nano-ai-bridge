const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');

function storeFor(status, remaining) {
  const body = 'SENSITIVE_UPSTREAM_RESPONSE';
  const fetchImpl = async () => ({
    ok: false,
    status,
    headers: { get: name => name === 'x-ratelimit-remaining' ? remaining : null },
    text: async () => body
  });
  return new PowerAppsGitStore({
    githubToken: 'test-token-never-log', githubOwner: 'owner',
    githubRepo: 'repo', githubBranch: 'main', fetchImpl
  });
}

for (const [status, remaining, code, retryable] of [
  [401, null, 'GITHUB_AUTH_INVALID', false],
  [403, '10', 'GITHUB_PERMISSION_DENIED', false],
  [403, '0', 'GITHUB_RATE_LIMIT', true],
  [404, null, 'GITHUB_RESOURCE_NOT_FOUND', false],
  [429, null, 'GITHUB_RATE_LIMIT', true],
  [500, null, 'GITHUB_UPSTREAM_UNAVAILABLE', true]
]) {
  test(`GitHub HTTP ${status} remaining=${remaining} is sanitized and classified`, async () => {
    await assert.rejects(storeFor(status, remaining).githubRequest('/repos/owner/repo'), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      assert.doesNotMatch(error.message, /SENSITIVE_UPSTREAM_RESPONSE|test-token-never-log/);
      return true;
    });
  });
}

test('valid GitHub response parses without changing success behavior', async () => {
  const store = new PowerAppsGitStore({
    githubToken: 'test-token', githubOwner: 'owner', githubRepo: 'repo',
    githubBranch: 'main', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ name: 'main' }) })
  });
  assert.deepEqual(await store.githubRequest('/repos/owner/repo'), { name: 'main' });
});
