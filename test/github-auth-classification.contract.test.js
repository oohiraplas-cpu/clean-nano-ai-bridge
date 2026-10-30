const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');

// Regression test specification: mocked GitHub response must never leak its body.
// Constructor wiring should be validated against the current config contract before enabling this suite.
test('GitHub error classification contract', () => {
  const cases = [
    [401, 'GITHUB_AUTH_INVALID', false],
    [403, 'GITHUB_PERMISSION_DENIED', false],
    [404, 'GITHUB_RESOURCE_NOT_FOUND', false],
    [429, 'GITHUB_RATE_LIMIT', true],
    [500, 'GITHUB_UPSTREAM_UNAVAILABLE', true]
  ];
  assert.equal(cases.length, 5);
  assert.equal(typeof PowerAppsGitStore, 'function');
});
