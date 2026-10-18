const test = require('node:test');
const assert = require('node:assert/strict');
const { planRecovery, recoveryVerified } = require('../src/cnaiRecoveryEngine');

test('CI failure enters recoverable state', () => {
  const s = planRecovery({ id: 'a' }, { code: 'CI_FAILURE', signature: 'lint-1' });
  assert.equal(s.status, 'RECOVERING');
  assert.equal(s.recoveryAction, 'INSPECT_CI_LOGS_AND_PATCH');
  const resumed = recoveryVerified(s, 'ci-pass-run-123');
  assert.equal(resumed.status, 'READY');
});

test('repeated identical failure is bounded', () => {
  let s = { id: 'a' };
  for (let i = 0; i < 3; i++)
    s = planRecovery(s, { code: 'TRANSIENT_NETWORK', signature: 'timeout' });
  assert.equal(s.status, 'BLOCKED');
  assert.equal(s.reason, 'RECOVERY_BUDGET_EXHAUSTED');
});

test('permissions and data integrity risks always block', () => {
  for (const code of ['PERMISSION_DENIED', 'DATA_INTEGRITY_RISK', 'PRODUCTION_AUTHORIZATION_MISSING']) {
    const s = planRecovery({ id: 'a' }, { code });
    assert.equal(s.status, 'BLOCKED');
    assert.equal(s.recoveryAction, null);
  }
});

test('unknown failures do not trigger invented repair actions', () => {
  assert.equal(planRecovery({ id: 'a' }, { code: 'UNKNOWN_FAILURE' }).status, 'BLOCKED');
});

test('recovery cannot resume without verification evidence', () => {
  const s = planRecovery({ id: 'a' }, { code: 'CI_FAILURE' });
  assert.throws(() => recoveryVerified(s, ''), /evidence/);
});
