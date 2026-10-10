const test = require('node:test');
const assert = require('node:assert/strict');
const { STEPS, initialState, currentStep, advance, resume } = require('../src/cnaiAutoPipeline');

test('all nine stages run in order with verified evidence and authorization', () => {
  let state = initialState('job-1');
  for (const step of STEPS) {
    assert.equal(currentStep(state), step);
    state = advance(state, { step, success: true, evidenceId: 'proof-' + step }, {
      authorized: true, humanApproved: true
    });
  }
  assert.equal(state.status, 'DONE');
  assert.equal(state.history.length, 9);
});

test('unverified evidence blocks progress', () => {
  const state = advance(initialState('job-2'), { step: 'PR_COMPLETE', success: false });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.reason, 'VERIFIED_EVIDENCE_REQUIRED');
});

test('production deploy cannot proceed without authorization', () => {
  let state = initialState('job-3');
  for (const step of STEPS.slice(0, 2))
    state = advance(state, { step, success: true, evidenceId: step });
  state = advance(state, { step: 'AZURE_DEPLOY', success: true, evidenceId: 'deploy-proof' });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.reason, 'EXPLICIT_AUTHORIZATION_REQUIRED');
});

test('publication requires human approval', () => {
  let state = initialState('job-4');
  for (const step of STEPS.slice(0, -1))
    state = advance(state, { step, success: true, evidenceId: step }, { authorized: true });
  state = advance(state, { step: 'PUBLISH_APPROVAL', success: true, evidenceId: 'proof' });
  assert.equal(state.status, 'WAITING_APPROVAL');
});

test('resume requires authorization and keeps checkpoint', () => {
  const blocked = advance(initialState('job-5'), {});
  assert.throws(() => resume(blocked), /authorization/);
  const state = resume(blocked, { resumeAuthorized: true });
  assert.equal(state.index, 0);
  assert.equal(state.status, 'READY');
});
