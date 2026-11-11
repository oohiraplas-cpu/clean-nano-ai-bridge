/**
 * Tests for Operation Context Manager
 * Covers context lifecycle, propagation, validation, and injection
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  OperationContext,
  ContextInjector,
  ContextValidator,
  ContextPropagator
} = require('../src/operationContextManager');

test('OperationContext', async (t) => {
  await t.test('creates context with valid parameters', () => {
    const context = new OperationContext('op-1', 'user-1', 'save_app');
    assert.strictEqual(context.operationId, 'op-1');
    assert.strictEqual(context.userId, 'user-1');
    assert.strictEqual(context.operationType, 'save_app');
    assert.ok(context.correlationId);
    assert.strictEqual(context.status, 'active');
  });

  await t.test('throws on missing operationId', () => {
    assert.throws(() => new OperationContext('', 'user-1', 'op'), /operationId must be non-empty/);
  });

  await t.test('throws on missing userId', () => {
    assert.throws(() => new OperationContext('op-1', '', 'op'), /userId must be non-empty/);
  });

  await t.test('throws on missing operationType', () => {
    assert.throws(() => new OperationContext('op-1', 'user-1', ''), /operationType must be non-empty/);
  });

  await t.test('records operation steps', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.recordStep('validate', { field: 'name' });
    context.recordStep('persist', { rows: 5 });

    assert.strictEqual(context.steps.length, 2);
    assert.strictEqual(context.steps[0].name, 'validate');
    assert.strictEqual(context.steps[1].sequenceNumber, 1);
  });

  await t.test('throws when recording step on inactive context', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.complete({});

    assert.throws(() => context.recordStep('step', {}), /operation not active/);
  });

  await t.test('completes operation with result', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.complete({ saved: true });

    assert.strictEqual(context.status, 'completed');
    assert.deepStrictEqual(context.result, { saved: true });
    assert.ok(context.duration >= 0);
  });

  await t.test('fails operation with error', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const error = new Error('Validation failed');

    context.fail(error);

    assert.strictEqual(context.status, 'failed');
    assert.strictEqual(context.error.message, 'Validation failed');
    assert.ok(context.duration >= 0);
  });

  await t.test('throws when completing already completed operation', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.complete({});

    assert.throws(() => context.complete({}), /already completed/);
  });

  await t.test('sets parent operation correctly', () => {
    const parentContext = new OperationContext('parent-op', 'user-1', 'root');
    const childContext = new OperationContext('child-op', 'user-1', 'child');

    childContext.setParentOperation(parentContext.operationId, parentContext.traceChain);

    assert.strictEqual(childContext.parentOperationId, 'parent-op');
    assert.deepStrictEqual(childContext.traceChain, ['parent-op', 'child-op']);
  });

  await t.test('detects expired context', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.ttlSeconds = -1; // Already expired
    context.expiresAt = Date.now() - 1000;

    assert.strictEqual(context.isExpired(), true);
  });

  await t.test('generates consistent hash', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const hash1 = context.generateHash();
    const hash2 = context.generateHash();

    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64); // SHA256 hex length
  });

  await t.test('exports context for propagation', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.recordStep('validate');

    const exported = context.exportContext();

    assert.strictEqual(exported.operationId, 'op-1');
    assert.ok(exported.correlationId);
    assert.ok(exported.contextHash);
    assert.deepStrictEqual(exported.traceChain, ['op-1']);
  });

  await t.test('getSummary returns operation summary', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.recordStep('step1');
    context.complete({});

    const summary = context.getSummary();

    assert.strictEqual(summary.operationId, 'op-1');
    assert.strictEqual(summary.status, 'completed');
    assert.strictEqual(summary.stepCount, 1);
    assert.strictEqual(summary.hasError, false);
  });
});

test('ContextInjector', async (t) => {
  await t.test('injects context into HTTP headers', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const headers = {};

    const injected = ContextInjector.injectIntoHttpHeaders(headers, context);

    assert.strictEqual(injected['X-Operation-Id'], 'op-1');
    assert.strictEqual(injected['X-User-Id'], 'user-1');
    assert.strictEqual(injected['X-Operation-Type'], 'save');
    assert.ok(injected['X-Correlation-Id']);
    assert.ok(injected['X-Trace-Chain']);
    assert.ok(injected['X-Context-Hash']);
  });

  await t.test('throws on invalid context for HTTP injection', () => {
    assert.throws(() => ContextInjector.injectIntoHttpHeaders({}, null), /Invalid context/);
  });

  await t.test('extracts context from HTTP headers', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const headers = ContextInjector.injectIntoHttpHeaders({}, context);
    const lowerHeaders = {};

    for (const [key, value] of Object.entries(headers)) {
      lowerHeaders[key.toLowerCase()] = value;
    }

    const extracted = ContextInjector.extractFromHttpHeaders(lowerHeaders);

    assert.strictEqual(extracted.operationId, 'op-1');
    assert.strictEqual(extracted.userId, 'user-1');
    assert.ok(extracted.traceChain);
  });

  await t.test('returns null when operation ID missing', () => {
    const headers = { 'x-correlation-id': 'corr-1' };
    const extracted = ContextInjector.extractFromHttpHeaders(headers);

    assert.strictEqual(extracted, null);
  });

  await t.test('injects context into MCP body', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const body = { method: 'save_app' };

    const injected = ContextInjector.injectIntoMcpBody(body, context);

    assert.strictEqual(injected.method, 'save_app');
    assert.ok(injected._context);
    assert.strictEqual(injected._context.operationId, 'op-1');
  });

  await t.test('injects context into function call arguments', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const args = ['arg1', 'arg2'];

    const injected = ContextInjector.injectIntoFunctionCall(args, context);

    assert.strictEqual(injected[0], context);
    assert.strictEqual(injected[1], 'arg1');
    assert.strictEqual(injected[2], 'arg2');
  });
});

test('ContextValidator', async (t) => {
  await t.test('validates context integrity', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const result = ContextValidator.validateIntegrity(context);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.checks.length, 4);
  });

  await t.test('detects missing fields', () => {
    const invalidContext = { operationId: 'op-1' };
    const result = ContextValidator.validateIntegrity(invalidContext);

    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.length > 0);
  });

  await t.test('validates context hash successfully', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const hash = context.generateHash();

    const result = ContextValidator.validateHash(context, hash);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.matches, true);
  });

  await t.test('detects hash mismatch', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    const wrongHash = 'a'.repeat(64);

    const result = ContextValidator.validateHash(context, wrongHash);

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.matches, false);
  });

  await t.test('validates trace chain continuity', () => {
    const traceChain = ['op-1', 'op-2', 'op-3'];
    const result = ContextValidator.validateTraceChain(traceChain, 'op-2');

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.length, 3);
  });

  await t.test('detects duplicate IDs in trace chain', () => {
    const traceChain = ['op-1', 'op-2', 'op-1'];
    const result = ContextValidator.validateTraceChain(traceChain);

    assert.strictEqual(result.valid, false);
    assert.ok(result.issues[0].includes('duplicate'));
  });

  await t.test('validates context expiration', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.ttlSeconds = 3600;

    const result = ContextValidator.validateExpiration(context);

    assert.strictEqual(result.valid, true);
    assert.ok(result.remainingSeconds > 0);
  });

  await t.test('detects expired context', () => {
    const context = new OperationContext('op-1', 'user-1', 'save');
    context.expiresAt = Date.now() - 1000;

    const result = ContextValidator.validateExpiration(context);

    assert.strictEqual(result.valid, false);
  });
});

test('ContextPropagator', async (t) => {
  await t.test('creates root context', () => {
    const propagator = new ContextPropagator();
    const context = propagator.createRootContext('user-1', 'operation', { data: 'meta' });

    assert.ok(context);
    assert.strictEqual(context.userId, 'user-1');
    assert.strictEqual(context.operationType, 'operation');
  });

  await t.test('creates child context with parent chain', () => {
    const propagator = new ContextPropagator();
    const parent = propagator.createRootContext('user-1', 'root');
    const child = propagator.createChildContext(parent, 'child');

    assert.strictEqual(child.userId, parent.userId);
    assert.strictEqual(child.parentOperationId, parent.operationId);
    assert.strictEqual(child.correlationId, parent.correlationId);
    assert.ok(child.traceChain.length > parent.traceChain.length);
  });

  await t.test('throws on invalid parent context', () => {
    const propagator = new ContextPropagator();
    assert.throws(() => propagator.createChildContext(null, 'child'), /Invalid parent/);
  });

  await t.test('completes context and removes from active', () => {
    const propagator = new ContextPropagator();
    const context = propagator.createRootContext('user-1', 'op');

    propagator.completeContext(context, { result: 'ok' });

    assert.strictEqual(propagator.getActiveContext(context.operationId), null);
    assert.ok(propagator.getHistory().length > 0);
  });

  await t.test('fails context and records in history', () => {
    const propagator = new ContextPropagator();
    const context = propagator.createRootContext('user-1', 'op');
    const error = new Error('Operation failed');

    propagator.failContext(context, error);

    assert.strictEqual(context.status, 'failed');
    assert.ok(propagator.getHistory().length > 0);
  });

  await t.test('throws when completing unknown context', () => {
    const propagator = new ContextPropagator();
    const fakeContext = new OperationContext('unknown', 'user-1', 'op');

    assert.throws(() => propagator.completeContext(fakeContext, {}), /not found/);
  });

  await t.test('retrieves active context by ID', () => {
    const propagator = new ContextPropagator();
    const context = propagator.createRootContext('user-1', 'op');

    const retrieved = propagator.getActiveContext(context.operationId);

    assert.strictEqual(retrieved, context);
  });

  await t.test('returns all active contexts', () => {
    const propagator = new ContextPropagator();
    propagator.createRootContext('user-1', 'op1');
    propagator.createRootContext('user-1', 'op2');
    propagator.createRootContext('user-1', 'op3');

    const active = propagator.getActiveContexts();

    assert.strictEqual(active.length, 3);
  });

  await t.test('retrieves context history with limit', () => {
    const propagator = new ContextPropagator();

    for (let i = 0; i < 50; i++) {
      const context = propagator.createRootContext('user-1', `op${i}`);
      propagator.completeContext(context, {});
    }

    const history = propagator.getHistory(20);

    assert.ok(history.length <= 20);
  });

  await t.test('cleans up expired contexts', () => {
    const propagator = new ContextPropagator();
    const context1 = propagator.createRootContext('user-1', 'op1');
    const context2 = propagator.createRootContext('user-1', 'op2');

    context1.expiresAt = Date.now() - 1000;

    const removed = propagator.cleanupExpiredContexts();

    assert.strictEqual(removed, 1);
    assert.strictEqual(propagator.getActiveContext(context1.operationId), null);
    assert.ok(propagator.getActiveContext(context2.operationId));
  });

  await t.test('returns propagator statistics', () => {
    const propagator = new ContextPropagator();
    propagator.createRootContext('user-1', 'op1');
    propagator.createRootContext('user-1', 'op2');

    const stats = propagator.getStats();

    assert.strictEqual(stats.activeContextCount, 2);
    assert.ok(stats.maxHistorySize > 0);
  });

  await t.test('clears all contexts', () => {
    const propagator = new ContextPropagator();
    propagator.createRootContext('user-1', 'op1');
    propagator.createRootContext('user-1', 'op2');

    propagator.clear();

    assert.strictEqual(propagator.getActiveContexts().length, 0);
    assert.strictEqual(propagator.getHistory().length, 0);
  });

  await t.test('integration: complete operation lifecycle', async () => {
    const propagator = new ContextPropagator();

    // Create root context
    const root = propagator.createRootContext('user-1', 'save_app');
    root.recordStep('init', { app: 'test' });

    // Create child context
    const validate = propagator.createChildContext(root, 'validate_schema');
    validate.recordStep('check_fields');

    // Create another child from root
    const save = propagator.createChildContext(root, 'persist_data');
    save.recordStep('write_db', { rows: 10 });

    // Complete operations
    propagator.completeContext(validate, { valid: true });
    propagator.completeContext(save, { saved: 10 });
    propagator.completeContext(root, { success: true });

    // Verify history
    const history = propagator.getHistory(100);
    assert.strictEqual(history.length, 3);
    assert.ok(history.every(h => h.correlationId === root.correlationId));
  });

  await t.test('integration: context propagation with validation', () => {
    const propagator = new ContextPropagator();
    const context = propagator.createRootContext('user-1', 'operation');

    // Inject into headers
    const headers = ContextInjector.injectIntoHttpHeaders({}, context);

    // Extract from headers (simulating cross-service call)
    const lowerHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }

    const extracted = ContextInjector.extractFromHttpHeaders(lowerHeaders);

    // Validate extracted context
    const validation = ContextValidator.validateHash(context, extracted.contextHash);

    assert.strictEqual(validation.valid, true);
  });
});
