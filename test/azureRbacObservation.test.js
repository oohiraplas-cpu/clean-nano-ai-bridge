const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { observeRbac } = require('../src/azureRbacObservation');
const resourceId = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/clean-nano-ai-bridge';
const principalId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
test('RBAC observation rejects invalid targets without invoking Azure', () => {
  let called = false;
  const result = observeRbac({ resourceId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/other',
    principalId, run: () => { called = true; } });
  assert.equal(result.status, 'blocked');
  assert.equal(called, false);
});
test('role assignment observations do not prove effective RBAC', () => {
  const result = observeRbac({ resourceId, principalId,
    run: (_cmd, args) => {
      assert.deepEqual(args.slice(0, 3), ['role', 'assignment', 'list']);
      return JSON.stringify([{ scope: resourceId, principalId, roleDefinitionId: '/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/role' }]);
    } });
  assert.equal(result.status, 'observed_not_verified');
  assert.equal(result.effectiveRbacVerified, false);
  assert.equal(result.assignmentCount, 1);
});
test('RBAC reader fails closed and has no secret or write operations', () => {
  const result = observeRbac({ resourceId, principalId, run: () => { throw Error('not authorized: secret'); } });
  assert.equal(result.status, 'blocked');
  assert.ok(!JSON.stringify(result).includes('secret'));
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/azureRbacObservation.js'), 'utf8');
  assert.ok(source.includes("'--include-inherited'"));
  assert.doesNotMatch(source, /\['role', 'assignment', '(create|delete)'|appsettings|list-secrets|access-token/);
});
