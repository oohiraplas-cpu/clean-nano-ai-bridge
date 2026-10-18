const test = require('node:test');
const assert = require('node:assert/strict');
const { planExecution, evaluateCompletion } = require('../src/cnaiStrategicOrchestrator');

test('parallelizes independent verified read-only tasks', () => {
  const result = planExecution('release', [
    { id: 'a', readOnly: true, preflightVerified: true },
    { id: 'b', readOnly: true, preflightVerified: true },
    { id: 'c', dependsOn: ['a', 'b'], readOnly: false }
  ]);
  assert.deepEqual(result.waves, [['a', 'b'], ['c']]);
});

test('detects cyclic dependencies', () => {
  assert.throws(() => planExecution('release', [
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }
  ]), /cycle/);
});

test('never parallelizes mutating work by default', () => {
  const result = planExecution('release', [
    { id: 'a', readOnly: false }, { id: 'b', readOnly: false }
  ]);
  assert.deepEqual(result.waves, [['a'], ['b']]);
});

test('completion requires all evidence', () => {
  assert.equal(evaluateCompletion(['ci', 'deploy'], { ci: 'run-1' }).status, 'PARTIAL');
  assert.equal(evaluateCompletion(['ci', 'deploy'], { ci: 'run-1', deploy: 'sha-1' }).status, 'DONE');
});
