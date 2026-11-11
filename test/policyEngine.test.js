const test = require('node:test');
const assert = require('node:assert');
const { PolicyEngine, DEFAULT_POLICIES } = require('../src/policyEngine');

test('Policy Engine', async (t) => {
  await t.test('creates engine with default policies', () => {
    const engine = new PolicyEngine();

    assert.ok(engine.policies.size > 0);
    assert.ok(engine.policies.has('policy:main-branch-protected'));
    assert.ok(engine.policies.has('policy:deletion-prohibited'));
  });

  await t.test('evaluates policy for matching operation type', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'delete',
      context: {}
    });

    assert.strictEqual(result.allowed, false);
    assert.ok(result.code.includes('DELETION'));
  });

  await t.test('allows operation when no policies apply', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'save',
      context: {
        source: { branch: 'feature', sourceOrigin: 'github_canonical' }
      }
    });

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.code, 'POLICY_OK');
  });

  await t.test('registers custom policy', () => {
    const engine = new PolicyEngine({});

    const customPolicy = {
      id: 'policy:custom',
      description: 'Custom test policy',
      effect: 'deny',
      code: 'CUSTOM_DENIED'
    };

    engine.registerPolicy('policy:custom', customPolicy);

    assert.ok(engine.policies.has('policy:custom'));
  });

  await t.test('throws when registering duplicate policy', () => {
    const engine = new PolicyEngine();

    try {
      engine.registerPolicy('policy:main-branch-protected', {});
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('already registered'));
    }
  });

  await t.test('updates existing policy', () => {
    const engine = new PolicyEngine({
      'policy:test': { id: 'policy:test', description: 'Test', effect: 'deny' }
    });

    engine.updatePolicy('policy:test', { description: 'Updated' });

    const policy = engine.policies.get('policy:test');
    assert.strictEqual(policy.description, 'Updated');
  });

  await t.test('throws when updating non-existent policy', () => {
    const engine = new PolicyEngine({});

    try {
      engine.updatePolicy('policy:nonexistent', {});
      assert.fail('Should have thrown');
    } catch (error) {
      assert.ok(error.message.includes('not found'));
    }
  });

  await t.test('lists all policies', () => {
    const engine = new PolicyEngine();

    const policies = engine.listPolicies();

    assert.ok(Array.isArray(policies));
    assert.ok(policies.length > 0);
    assert.ok(policies.some(p => p.id === 'policy:main-branch-protected'));
  });

  await t.test('denies publish without approval', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'publish',
      context: {}
    });

    assert.strictEqual(result.approvalRequired, true);
  });

  await t.test('denies merge without approval', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'merge',
      context: {}
    });

    assert.strictEqual(result.approvalRequired, true);
  });

  await t.test('denies deploy to production', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'deploy',
      context: { environment: 'production' }
    });

    assert.strictEqual(result.allowed, false);
  });

  await t.test('denies deletion', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'delete',
      context: {}
    });

    assert.strictEqual(result.allowed, false);
    assert.ok(result.recoveryAction);
  });

  await t.test('denies rename without approval', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'rename',
      context: {}
    });

    assert.strictEqual(result.approvalRequired, true);
  });

  await t.test('denies permission changes without approval', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'update_permissions',
      context: {}
    });

    assert.strictEqual(result.approvalRequired, true);
  });

  await t.test('denies public disclosure', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'public_share',
      context: {}
    });

    assert.strictEqual(result.allowed, false);
  });

  await t.test('denies billing changes', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'billing_change',
      context: {}
    });

    assert.strictEqual(result.allowed, false);
  });

  await t.test('denies audit trail modification', async () => {
    const engine = new PolicyEngine();

    const result = await engine.evaluatePolicy({
      operationType: 'modify_audit',
      context: {}
    });

    assert.strictEqual(result.allowed, false);
  });

  await t.test('requiresApproval returns true when policy requires', async () => {
    const engine = new PolicyEngine();

    const result = engine.requiresApproval('publish', {});

    assert.strictEqual(result, true);
  });

  await t.test('requiresApproval returns false when no approval needed', async () => {
    const engine = new PolicyEngine();

    const result = engine.requiresApproval('save', {
      source: { branch: 'feature' }
    });

    assert.strictEqual(result, false);
  });

  await t.test('getSummary includes policy count and details', () => {
    const engine = new PolicyEngine();

    const summary = engine.getSummary();

    assert.ok(summary.version);
    assert.strictEqual(typeof summary.totalPolicies, 'number');
    assert.ok(Array.isArray(summary.policies));
    assert.ok(summary.policies.length > 0);
  });

  await t.test('each policy in summary has required fields', () => {
    const engine = new PolicyEngine();

    const summary = engine.getSummary();

    for (const policy of summary.policies) {
      assert.ok(policy.id);
      assert.ok(policy.description);
      assert.ok(policy.effect);
      assert.strictEqual(typeof policy.approvalRequired, 'boolean');
    }
  });
});
