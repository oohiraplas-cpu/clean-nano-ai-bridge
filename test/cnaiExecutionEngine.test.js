const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createExecutionPlan, assessFailure, verifyPreflight, checkDone
} = require('../src/cnaiExecutionEngine');

test('unified engine plans safe execution without side effects', () => {
  const plan = createExecutionPlan({
    id: 'release-1', goal: 'release',
    tasks: [{ id: 'inspect', readOnly: true, preflightVerified: true }]
  });
  assert.equal(plan.nextStep, 'PR_COMPLETE');
  assert.deepEqual(plan.execution.waves, [['inspect']]);
  assert.equal(plan.automaticExecutionEnabled, false);
});

test('recovery integrates diagnosis with verified candidate ranking', () => {
  const result = assessFailure({
    state: { id: 'release-1' },
    failure: { code: 'CI_FAILURE', signature: 'test-1' },
    candidates: [{ action: 'INSPECT_CI_LOGS_AND_PATCH',
      authorized: true, preconditionsVerified: true }]
  });
  assert.equal(result.recovery.status, 'RECOVERING');
  assert.equal(result.decision.selected.action, 'INSPECT_CI_LOGS_AND_PATCH');
});

test('preflight and DONE remain evidence gated', () => {
  assert.equal(verifyPreflight({ targetLocked: true }).status, 'BLOCKED');
  assert.equal(checkDone(['ci', 'azure'], { ci: 'run-1' }).status, 'PARTIAL');
});
