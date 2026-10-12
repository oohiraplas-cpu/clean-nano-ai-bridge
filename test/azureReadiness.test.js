const test = require('node:test');
const assert = require('node:assert/strict');
const { assessAzureReadiness, REQUIRED } = require('../src/azureReadiness');

test('missing Azure observations block readiness without exposing secrets', () => {
  const result = assessAzureReadiness({});
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.missing, REQUIRED);
  assert.equal(JSON.stringify(result).includes('password'), false);
});
test('partial observations do not pass', () => {
  const result = assessAzureReadiness({ healthVerified: true, managedIdentityAssigned: true });
  assert.equal(result.status, 'blocked');
  assert.ok(result.missing.includes('rbacReadVerified'));
});
test('all observed checks permit review but not deployment', () => {
  const result = assessAzureReadiness(Object.fromEntries(REQUIRED.map(k => [k, true])));
  assert.equal(result.status, 'ready_for_review');
  assert.deepEqual(result.missing, []);
  assert.equal(Object.hasOwn(result, 'deploymentAuthorized'), false);
});
test('truthy non-booleans do not count as verified', () => {
  const result = assessAzureReadiness(Object.fromEntries(REQUIRED.map(k => [k, 'true'])));
  assert.equal(result.status, 'blocked');
});
