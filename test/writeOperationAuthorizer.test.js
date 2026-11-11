const test = require('node:test');
const assert = require('node:assert');
const {
  REJECTION_CODES,
  WriteOperationAuthorizer
} = require('../src/writeOperationAuthorizer');
const { ExecutionContract } = require('../src/stateContextV2');

test('Write Operation Authorizer', async (t) => {
  const createValidContext = () => new ExecutionContract({
    target: { appId: 'app1', environmentId: 'env1', displayName: 'App1' },
    source: {
      provider: 'github',
      repository: 'clean-nano-ai-bridge',
      root: 'powerapps/CN_AI依頼台帳/Source',
      path: 'test.json',
      branch: 'main',
      canonicalBranch: 'main',
      expectedSha: 'a'.repeat(40),
      actualSha: 'a'.repeat(40),
      sourceOrigin: 'github_canonical'
    },
    authorization: {
      state: 'ready',
      writable: true,
      publishable: false,
      approvalRequired: false
    },
    evidence: {
      planHash: 'b'.repeat(64),
      precheckHash: 'c'.repeat(64),
      resultHash: 'd'.repeat(64),
      auditReference: 'audit:test'
    }
  });

  await t.test('authorizes valid save operation', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.code, 'AUTHORIZED');
    assert.strictEqual(result.externalApiCalled, false);
  });

  await t.test('denies when context is missing', async () => {
    const authorizer = new WriteOperationAuthorizer();

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save'
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.MISSING_STATE_CONTEXT);
    assert.strictEqual(result.externalApiCalled, false);
  });

  await t.test('denies when context lacks required fields', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = { target: { appId: 'app1' } };

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.MISSING_STATE_CONTEXT);
  });

  await t.test('denies when appId in context is empty', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.target.appId = ''; // Clear appId

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    // When app/env missing, it's CONTEXT_IDENTITY_CONFLICT not APP_MISMATCH
    assert.strictEqual(result.code, REJECTION_CODES.CONTEXT_IDENTITY_CONFLICT);
  });

  await t.test('denies when environmentId in context is empty', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.target.environmentId = ''; // Clear environmentId

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.CONTEXT_IDENTITY_CONFLICT);
  });

  await t.test('denies when branch is not canonical', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.source.branch = 'feature/test';

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.NON_CANONICAL_BRANCH);
  });

  await t.test('denies when SHA mismatches between expected and actual', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.source.expectedSha = 'a'.repeat(40);
    context.source.actualSha = 'e'.repeat(40);

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.SOURCE_SHA_MISMATCH);
  });

  await t.test('denies when source origin is missing', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.source.sourceOrigin = '';

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.SOURCE_ORIGIN_MISSING);
  });

  await t.test('denies when authorization writable is false', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.authorization.state = 'ready';
    context.authorization.writable = false; // Test writable=false

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    // Writable check happens during state/authorization validation
    assert.ok([REJECTION_CODES.STATE_NOT_READY, REJECTION_CODES.WRITE_NOT_ALLOWED].includes(result.code));
  });


  await t.test('denies publish when publishable is false', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.authorization.publishable = false;

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'publish',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.PUBLISH_NOT_ALLOWED);
  });

  await t.test('denies when approval required', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.authorization.approvalRequired = true;

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.APPROVAL_REQUIRED);
  });

  await t.test('allows publish when all conditions met', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.authorization.publishable = true;

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'publish',
      context
    });

    assert.strictEqual(result.allowed, true);
  });

  await t.test('denies when TTL is expired', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.runtime.expiresAt = new Date(Date.now() - 1000).toISOString();

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.EXPIRED_STATE_CONTEXT);
  });

  await t.test('includes auditReference in result', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.ok(result.auditReference);
    assert.ok(result.auditReference.startsWith('audit:'));
  });

  await t.test('includes recoveryAction in denial', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.authorization.state = 'blocked';

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.ok(result.recoveryAction);
    assert.ok(result.recoveryAction.length > 0);
  });

  await t.test('returns externalApiCalled = false on rejection', async () => {
    const authorizer = new WriteOperationAuthorizer();

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save'
    });

    assert.strictEqual(result.externalApiCalled, false);
  });

  await t.test('returns externalApiCalled = false on authorization', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.externalApiCalled, false);
  });

  await t.test('validates target fields exist', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.target.appId = '';

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.ok(result.code === REJECTION_CODES.CONTEXT_IDENTITY_CONFLICT ||
              result.code === REJECTION_CODES.MISSING_STATE_CONTEXT);
  });

  await t.test('validates source fields exist', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.source.branch = '';

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
  });

  await t.test('denies when SHA format is invalid', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();
    context.source.actualSha = 'invalid';

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, REJECTION_CODES.SOURCE_SHA_MISMATCH);
  });

  await t.test('includes context in result on authorization', async () => {
    const authorizer = new WriteOperationAuthorizer();
    const context = createValidContext().toJSON();

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save',
      context
    });

    assert.ok(result.context);
    assert.strictEqual(result.context.target.appId, 'app1');
  });

  await t.test('includes context in result on denial', async () => {
    const authorizer = new WriteOperationAuthorizer();

    const result = await authorizer.authorizeWriteOperation({
      operationType: 'save'
    });

    assert.ok(result.context);
  });
});
