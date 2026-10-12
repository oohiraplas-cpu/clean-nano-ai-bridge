'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerPlatformRequestHandler } = require('../src/powerPlatformRequestHandler');
function handler(p0Execution) { return new PowerPlatformRequestHandler({ config: { p0Execution } }); }
const sha = 'a'.repeat(40);
const input = { operation: 'save', targetSha: sha, observedSha: sha, requestId: 'req', actorId: 'actor' };
test('unconfigured runtime blocks before mutation', async () => {
  assert.equal((await handler().executeP0Mutation(input)).reason, 'p0_runtime_not_configured');
});
test('missing approval ledger blocks before mutation', async () => {
  let calls = 0;
  const p0 = {
    getEvidence: async () => ({ backupVerified: true, testsPassed: true, changeHash: 'b'.repeat(64), environmentId: 'env', appId: 'app' }),
    perform: async () => { calls++; }, verifyResult: async () => ({}),
    readCurrentSha: async () => sha
  };
  assert.equal((await handler(p0).executeP0Mutation(input)).reason, 'ledger_not_configured');
  assert.equal(calls, 0);
});
test('HEAD changes after approval block mutation', async () => {
  let calls = 0;
  const p0 = {
    ledger: { configured: true, check: async () => ({ approved: true, approver: 'reviewer', bindingVerified: true }) },
    getEvidence: async () => ({ backupVerified: true, testsPassed: true, changeHash: 'b'.repeat(64), environmentId: 'env', appId: 'app' }),
    perform: async () => { calls++; }, verifyResult: async () => ({}),
    readCurrentSha: async () => 'b'.repeat(40)
  };
  assert.equal((await handler(p0).executeP0Mutation(input)).reason, 'head_changed');
  assert.equal(calls, 0);
});
test('successful callback alone is not proof of saved version', async () => {
  let calls = 0;
  const p0 = {
    ledger: { configured: true, check: async () => ({ approved: true, approver: 'reviewer', bindingVerified: true }) },
    getEvidence: async () => ({ backupVerified: true, testsPassed: true, changeHash: 'b'.repeat(64), environmentId: 'env', appId: 'app' }),
    perform: async () => { calls++; return { success: true }; },
    verifyResult: async () => ({ actualSha: sha, operationConfirmed: true, appCheckerCritical: 0 }),
    readCurrentSha: async () => sha
  };
  assert.equal((await handler(p0).executeP0Mutation(input)).reason, 'version_unverified');
  assert.equal(calls, 1);
});

test('postflight cannot override operation or expected SHA', async () => {
  const p0 = {
    ledger: { configured: true, check: async () => ({ approved: true, approver: 'reviewer', bindingVerified: true }) },
    getEvidence: async () => ({ backupVerified: true, testsPassed: true, changeHash: 'b'.repeat(64), environmentId: 'env', appId: 'app' }),
    perform: async () => ({ success: true }),
    verifyResult: async () => ({ operation: 'merge', expectedSha: 'b'.repeat(40), actualSha: sha, operationConfirmed: true, appCheckerCritical: 0 }),
    readCurrentSha: async () => sha
  };
  assert.equal((await handler(p0).executeP0Mutation(input)).reason, 'version_unverified');
});
