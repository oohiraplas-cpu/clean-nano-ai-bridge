const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseRecovery, preflight } = require('../src/cnaiAdaptiveIntelligence');

test('chooses lowest-risk verified authorized recovery', () => {
  const result = chooseRecovery([
    { action: 'INSPECT_DEPLOY_LOGS_AND_REDEPLOY', authorized: true, preconditionsVerified: true },
    { action: 'REFETCH_AND_COMPARE', authorized: true, preconditionsVerified: true }
  ]);
  assert.equal(result.selected.action, 'REFETCH_AND_COMPARE');
});

test('avoids failed recovery actions', () => {
  const result = chooseRecovery([
    { action: 'REFETCH_AND_COMPARE', authorized: true, preconditionsVerified: true },
    { action: 'REBASE_AND_RETEST', authorized: true, preconditionsVerified: true }
  ], [{ action: 'REFETCH_AND_COMPARE', success: false }]);
  assert.equal(result.selected.action, 'REBASE_AND_RETEST');
});

test('rejects unknown and unverified operations', () => {
  const result = chooseRecovery([
    { action: 'BYPASS_APPROVAL', authorized: true, preconditionsVerified: true },
    { action: 'REFETCH_AND_COMPARE', authorized: false, preconditionsVerified: true }
  ]);
  assert.equal(result.status, 'NEEDS_EVIDENCE');
});

test('preflight requires complete safety evidence', () => {
  assert.equal(preflight({ targetLocked: true }).status, 'BLOCKED');
  assert.equal(preflight({
    targetLocked: true, sourceVerified: true, backupVerified: true,
    authorizationVerified: true, rollbackAvailable: true
  }).status, 'READY');
});
