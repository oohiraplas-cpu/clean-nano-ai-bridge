const test = require('node:test');
const assert = require('node:assert');
const {
  CONTEXT_VERSION,
  REQUIRED_FIELDS,
  ExecutionContract
} = require('../src/stateContextV2');

test('State Context V2 - ExecutionContract', async (t) => {
  await t.test('creates contract with all required fields', () => {
    const contract = new ExecutionContract();

    // Verify all required fields exist
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in contract, `Missing required field: ${field}`);
    }

    // Verify contextVersion
    assert.strictEqual(contract.contextVersion, CONTEXT_VERSION);

    // Verify UUIDs are generated
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contract.correlationId));
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contract.stateSessionId));
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contract.operationId));

    // Verify defaults
    assert.strictEqual(contract.authorization.state, 'blocked');
    assert.strictEqual(contract.authorization.writable, false);
  });

  await t.test('accepts partial context and fills in defaults', () => {
    const partial = {
      target: {
        appId: 'test-app',
        environmentId: 'test-env',
        displayName: 'Test App'
      },
      source: {
        branch: 'main',
        canonicalBranch: 'main',
        actualSha: 'a'.repeat(40),
        sourceOrigin: 'github_canonical'
      }
    };

    const contract = new ExecutionContract(partial);

    assert.strictEqual(contract.target.appId, 'test-app');
    assert.strictEqual(contract.target.environmentId, 'test-env');
    assert.strictEqual(contract.source.branch, 'main');
    assert.ok(contract.correlationId); // Generated
  });

  await t.test('validates all required fields', () => {
    const contract = new ExecutionContract({
      target: { appId: 'app1', environmentId: 'env1', displayName: 'App1' },
      source: {
        branch: 'main',
        canonicalBranch: 'main',
        actualSha: 'b'.repeat(40),
        sourceOrigin: 'github_canonical'
      }
    });

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.length > 0);
  });

  await t.test('validates contextVersion', () => {
    const contract = new ExecutionContract();
    contract.contextVersion = '1.0.0';

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('contextVersion')));
  });

  await t.test('validates UUID format for IDs', () => {
    const contract = new ExecutionContract();
    contract.correlationId = 'not-a-uuid';

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('correlationId')));
  });

  await t.test('validates target fields', () => {
    const contract = new ExecutionContract();
    contract.target = { appId: '', environmentId: 'env' };

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('target')));
  });

  await t.test('validates source.actualSha format', () => {
    const contract = new ExecutionContract({
      target: { appId: 'app', environmentId: 'env', displayName: 'App' },
      source: { actualSha: 'invalid-sha' }
    });

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('actualSha')));
  });

  await t.test('validates authorization boolean fields', () => {
    const contract = new ExecutionContract();
    contract.authorization.writable = 'true'; // String instead of boolean

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('writable')));
  });

  await t.test('validates authorization state values', () => {
    const contract = new ExecutionContract();
    contract.authorization.state = 'invalid_state';

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('state')));
  });

  await t.test('validates runtime ISO timestamps', () => {
    const contract = new ExecutionContract();
    contract.runtime.createdAt = 'not-iso';

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('createdAt')));
  });

  await t.test('validates evidence hash formats (SHA256)', () => {
    const contract = new ExecutionContract();
    contract.evidence.planHash = 'not-hex';

    const validation = contract.validate();
    assert.strictEqual(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('planHash')));
  });

  await t.test('canWrite returns false when state is blocked', () => {
    const contract = new ExecutionContract({
      authorization: { state: 'blocked', writable: false }
    });

    const result = contract.canWrite();
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('state'));
  });

  await t.test('canWrite returns false when writable is false', () => {
    const contract = new ExecutionContract({
      authorization: { state: 'ready', writable: false }
    });

    const result = contract.canWrite();
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('writable'));
  });

  await t.test('canWrite returns false for non-canonical branch', () => {
    const contract = new ExecutionContract({
      source: { branch: 'feature', canonicalBranch: 'main' },
      authorization: { state: 'ready', writable: true }
    });

    const result = contract.canWrite();
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('branch'));
  });

  await t.test('canWrite returns false on SHA mismatch', () => {
    const contract = new ExecutionContract({
      source: {
        branch: 'main',
        canonicalBranch: 'main',
        expectedSha: 'a'.repeat(40),
        actualSha: 'b'.repeat(40)
      },
      authorization: { state: 'ready', writable: true }
    });

    const result = contract.canWrite();
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('actualSha'));
  });

  await t.test('canWrite returns true when all conditions met', () => {
    const contract = new ExecutionContract({
      source: {
        branch: 'main',
        canonicalBranch: 'main',
        expectedSha: 'a'.repeat(40),
        actualSha: 'a'.repeat(40)
      },
      authorization: { state: 'ready', writable: true }
    });

    const result = contract.canWrite();
    assert.strictEqual(result.allowed, true);
    assert.ok(result.reason.includes('all conditions'));
  });

  await t.test('canPublish returns false when write not allowed', () => {
    const contract = new ExecutionContract({
      authorization: { state: 'blocked', writable: false }
    });

    const result = contract.canPublish();
    assert.strictEqual(result.allowed, false);
  });

  await t.test('canPublish returns false when publishable is false', () => {
    const contract = new ExecutionContract({
      source: {
        branch: 'main',
        canonicalBranch: 'main',
        expectedSha: 'a'.repeat(40),
        actualSha: 'a'.repeat(40)
      },
      authorization: { state: 'ready', writable: true, publishable: false }
    });

    const result = contract.canPublish();
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('publishable'));
  });

  await t.test('canPublish returns false when approval required', () => {
    const contract = new ExecutionContract({
      source: {
        branch: 'main',
        canonicalBranch: 'main',
        expectedSha: 'a'.repeat(40),
        actualSha: 'a'.repeat(40)
      },
      authorization: {
        state: 'ready',
        writable: true,
        publishable: true,
        approvalRequired: true
      }
    });

    const result = contract.canPublish();
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('approval'));
  });

  await t.test('canPublish returns true when all conditions met', () => {
    const contract = new ExecutionContract({
      source: {
        branch: 'main',
        canonicalBranch: 'main',
        expectedSha: 'a'.repeat(40),
        actualSha: 'a'.repeat(40)
      },
      authorization: {
        state: 'ready',
        writable: true,
        publishable: true,
        approvalRequired: false
      }
    });

    const result = contract.canPublish();
    assert.strictEqual(result.allowed, true);
  });

  await t.test('expire() sets state to expired and clears write/publish', () => {
    const contract = new ExecutionContract({
      authorization: { state: 'ready', writable: true, publishable: true }
    });

    contract.expire();

    assert.strictEqual(contract.authorization.state, 'expired');
    assert.strictEqual(contract.authorization.writable, false);
    assert.strictEqual(contract.authorization.publishable, false);
  });

  await t.test('updateRuntime() merges updates and sets updatedAt', (t) => {
    const contract = new ExecutionContract();
    const originalCreatedAt = contract.runtime.createdAt;

    // Small delay to ensure updatedAt differs
    setTimeout(() => {
      contract.updateRuntime({ version: '1.2.3' });

      assert.strictEqual(contract.runtime.version, '1.2.3');
      assert.strictEqual(contract.runtime.createdAt, originalCreatedAt);
      assert.ok(new Date(contract.runtime.updatedAt) > new Date(originalCreatedAt));
    }, 10);
  });

  await t.test('completeOperation() sets resultHash and updates runtime', (t) => {
    const contract = new ExecutionContract();
    const resultHash = 'c'.repeat(64);

    setTimeout(() => {
      contract.completeOperation(resultHash);

      assert.strictEqual(contract.evidence.resultHash, resultHash);
      assert.ok(new Date(contract.runtime.updatedAt) >= new Date(contract.runtime.createdAt));
    }, 10);
  });

  await t.test('toJSON() returns serializable object', () => {
    const contract = new ExecutionContract({
      target: { appId: 'app', environmentId: 'env', displayName: 'App' },
      evidence: {
        planHash: 'd'.repeat(64),
        precheckHash: 'e'.repeat(64),
        resultHash: 'f'.repeat(64)
      }
    });

    const json = contract.toJSON();

    assert.ok(json.contextVersion);
    assert.ok(json.correlationId);
    assert.strictEqual(json.target.appId, 'app');
    assert.strictEqual(typeof json.authorization.writable, 'boolean');

    // Verify it's serializable
    const stringified = JSON.stringify(json);
    const parsed = JSON.parse(stringified);
    assert.strictEqual(parsed.target.appId, 'app');
  });
});
