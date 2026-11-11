/**
 * Tests for Distributed Request Tracing & Context Propagation
 * Covers correlation IDs, operation contexts, context propagation, trace collection, and Fail-Closed enforcement
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  CorrelationIDGenerator,
  OperationContext,
  ContextPropagator,
  TraceCollector,
  FailClosedTracker,
  DistributedTracer
} = require('../src/distributedTracing');

test('CorrelationIDGenerator', async (t) => {
  await t.test('generates unique correlation IDs', () => {
    const gen = new CorrelationIDGenerator();
    const id1 = gen.generate();
    const id2 = gen.generate();

    assert.strictEqual(typeof id1, 'string');
    assert.strictEqual(typeof id2, 'string');
    assert.notStrictEqual(id1, id2);
    assert.ok(id1.startsWith('corr-'));
    assert.ok(id2.startsWith('corr-'));
  });

  await t.test('validates correlation ID format', () => {
    const gen = new CorrelationIDGenerator();
    const validId = gen.generate();
    const invalidId = 'invalid-id';
    const invalidFormat = 'corr-123';

    assert.ok(gen.isValid(validId));
    assert.strictEqual(gen.isValid(invalidId), false);
    assert.strictEqual(gen.isValid(invalidFormat), false);
    assert.strictEqual(gen.isValid(null), false);
    assert.strictEqual(gen.isValid(123), false);
  });

  await t.test('maintains generation history', () => {
    const gen = new CorrelationIDGenerator();
    gen.generate();
    gen.generate();
    gen.generate();

    const history = gen.getHistory();
    assert.strictEqual(history.length, 3);
    assert.ok(history[0].id);
    assert.ok(history[0].generatedAt);
  });

  await t.test('limits history to 10000 entries', () => {
    const gen = new CorrelationIDGenerator();
    for (let i = 0; i < 10100; i++) {
      gen.generate();
    }

    const history = gen.getHistory();
    assert.strictEqual(history.length, 10000);
  });
});

test('OperationContext', async (t) => {
  await t.test('initializes with required fields', () => {
    const context = new OperationContext('corr-123', 'user-1', 'fetch_data');

    assert.strictEqual(context.correlationId, 'corr-123');
    assert.strictEqual(context.userId, 'user-1');
    assert.strictEqual(context.operationType, 'fetch_data');
    assert.strictEqual(context.status, 'active');
    assert.ok(context.createdAt);
    assert.ok(context.startTime);
    assert.strictEqual(context.endTime, null);
    assert.strictEqual(context.duration, null);
  });

  await t.test('creates child contexts', () => {
    const parent = new OperationContext('corr-parent', 'user-1', 'parent_op');
    const child = parent.createChild('child_op', { name: 'test' });

    assert.strictEqual(child.correlationId, parent.correlationId);
    assert.strictEqual(child.userId, parent.userId);
    assert.strictEqual(child.operationType, 'child_op');
    assert.strictEqual(child.parentContextId, parent.correlationId);
    assert.ok(parent.childContextIds.includes(child.correlationId));
  });

  await t.test('records trace points', () => {
    const context = new OperationContext('corr-123', 'user-1', 'test_op');
    context.recordTracePoint('component_a', 'started', { step: 1 });
    context.recordTracePoint('component_b', 'completed', { result: 'ok' });

    assert.strictEqual(context.tracePoints.length, 2);
    assert.strictEqual(context.tracePoints[0].component, 'component_a');
    assert.strictEqual(context.tracePoints[0].event, 'started');
    assert.strictEqual(context.tracePoints[1].component, 'component_b');
  });

  await t.test('records Fail-Closed checkpoints', () => {
    const context = new OperationContext('corr-123', 'user-1', 'secure_op');
    context.recordFailClosedCheckpoint('auth_check', true);
    context.recordFailClosedCheckpoint('data_validation', false, 'Missing required field');

    assert.strictEqual(context.failClosedCheckpoints.length, 2);
    assert.strictEqual(context.failClosedCheckpoints[0].checkpoint, 'auth_check');
    assert.ok(context.failClosedCheckpoints[0].passed);
    assert.strictEqual(context.failClosedCheckpoints[1].checkpoint, 'data_validation');
    assert.strictEqual(context.failClosedCheckpoints[1].passed, false);
    assert.strictEqual(context.failClosedCheckpoints[1].reason, 'Missing required field');
  });

  await t.test('completes operation context', () => {
    const context = new OperationContext('corr-123', 'user-1', 'test_op');
    const startTime = context.startTime;

    // Simulate work
    setTimeout(() => {}, 10);
    context.complete('success');

    assert.strictEqual(context.status, 'success');
    assert.ok(context.endTime);
    assert.ok(context.duration >= 0);
  });

  await t.test('provides summary', () => {
    const context = new OperationContext('corr-123', 'user-1', 'test_op', { customField: 'value' });
    context.recordTracePoint('comp', 'event');
    context.recordFailClosedCheckpoint('check', true);
    context.complete('success');

    const summary = context.getSummary();
    assert.strictEqual(summary.correlationId, 'corr-123');
    assert.strictEqual(summary.userId, 'user-1');
    assert.strictEqual(summary.operationType, 'test_op');
    assert.strictEqual(summary.status, 'success');
    assert.ok(summary.duration >= 0);
    assert.strictEqual(summary.tracePointCount, 1);
    assert.strictEqual(summary.failClosedCheckpointCount, 1);
    assert.strictEqual(summary.hasFailedCheckpoints, false);
  });

  await t.test('provides full trace', () => {
    const context = new OperationContext('corr-123', 'user-1', 'test_op', { meta: 'data' });
    context.recordTracePoint('comp', 'event', { detail: 'info' });
    context.recordFailClosedCheckpoint('check', true);

    const fullTrace = context.getFullTrace();
    assert.ok(fullTrace.context);
    assert.ok(fullTrace.tracePoints);
    assert.ok(fullTrace.failClosedCheckpoints);
    assert.ok(fullTrace.metadata);
  });
});

test('ContextPropagator', async (t) => {
  await t.test('pushes and pops contexts', () => {
    const propagator = new ContextPropagator();
    const ctx1 = new OperationContext('corr-1', 'user-1', 'op-1');
    const ctx2 = new OperationContext('corr-2', 'user-1', 'op-2');

    propagator.pushContext(ctx1);
    assert.strictEqual(propagator.getStackDepth(), 1);

    propagator.pushContext(ctx2);
    assert.strictEqual(propagator.getStackDepth(), 2);

    const popped = propagator.popContext();
    assert.strictEqual(popped.correlationId, 'corr-2');
    assert.strictEqual(propagator.getStackDepth(), 1);
  });

  await t.test('retrieves current context', () => {
    const propagator = new ContextPropagator();
    assert.strictEqual(propagator.getCurrentContext(), null);

    const ctx = new OperationContext('corr-123', 'user-1', 'op');
    propagator.pushContext(ctx);
    const current = propagator.getCurrentContext();

    assert.strictEqual(current.correlationId, 'corr-123');
  });

  await t.test('executes function with context', async () => {
    const propagator = new ContextPropagator();
    const ctx = new OperationContext('corr-123', 'user-1', 'test_op');

    let executeWasCalled = false;
    const result = await propagator.executeWithContext(ctx, async (context) => {
      executeWasCalled = true;
      context.recordTracePoint('fn', 'executed');
      return 'success_result';
    });

    assert.ok(executeWasCalled);
    assert.strictEqual(result, 'success_result');
    assert.strictEqual(ctx.status, 'success');
    assert.strictEqual(ctx.tracePoints.length, 1);
    assert.strictEqual(propagator.getStackDepth(), 0); // Context popped
  });

  await t.test('handles function errors in executeWithContext', async () => {
    const propagator = new ContextPropagator();
    const ctx = new OperationContext('corr-123', 'user-1', 'test_op');

    try {
      await propagator.executeWithContext(ctx, async () => {
        throw new Error('Test error');
      });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.strictEqual(error.message, 'Test error');
      assert.strictEqual(ctx.status, 'failure');
      assert.strictEqual(ctx.tracePoints.length, 1);
    }
  });

  await t.test('maintains propagation history', () => {
    const propagator = new ContextPropagator();
    const ctx1 = new OperationContext('corr-1', 'user-1', 'op-1');
    const ctx2 = new OperationContext('corr-2', 'user-1', 'op-2');

    propagator.pushContext(ctx1);
    propagator.pushContext(ctx2);
    propagator.popContext();

    const history = propagator.getHistory();
    assert.strictEqual(history.length, 3); // push, push, pop
    assert.strictEqual(history[0].action, 'push');
    assert.strictEqual(history[2].action, 'pop');
  });
});

test('TraceCollector', async (t) => {
  await t.test('records traces', () => {
    const collector = new TraceCollector();
    const context = new OperationContext('corr-123', 'user-1', 'fetch_op');
    context.recordTracePoint('api', 'request_sent');
    context.recordTracePoint('api', 'response_received');
    context.complete('success');

    collector.recordTrace(context);

    const trace = collector.getTrace('corr-123');
    assert.ok(trace);
    assert.strictEqual(trace.summary.correlationId, 'corr-123');
    assert.strictEqual(trace.fullTrace.tracePoints.length, 2);
  });

  await t.test('updates performance statistics', () => {
    const collector = new TraceCollector();

    for (let i = 0; i < 3; i++) {
      const context = new OperationContext('corr-' + i, 'user-1', 'fetch_op');
      context.complete('success');
      // Simulate different durations
      context.duration = 100 + (i * 50);
      collector.recordTrace(context);
    }

    const stats = collector.getPerformanceStats();
    assert.ok(stats.fetch_op);
    assert.strictEqual(stats.fetch_op.count, 3);
    assert.strictEqual(stats.fetch_op.minDuration, 100);
    assert.strictEqual(stats.fetch_op.maxDuration, 200);
    assert.ok(stats.fetch_op.avgDuration > 100);
  });

  await t.test('queries traces by operation type', () => {
    const collector = new TraceCollector();

    const ctx1 = new OperationContext('corr-1', 'user-1', 'fetch_op');
    ctx1.complete('success');
    collector.recordTrace(ctx1);

    const ctx2 = new OperationContext('corr-2', 'user-1', 'fetch_op');
    ctx2.complete('success');
    collector.recordTrace(ctx2);

    const ctx3 = new OperationContext('corr-3', 'user-1', 'save_op');
    ctx3.complete('success');
    collector.recordTrace(ctx3);

    const fetchTraces = collector.queryTracesByOperation('fetch_op');
    assert.strictEqual(fetchTraces.length, 2);

    const saveTraces = collector.queryTracesByOperation('save_op');
    assert.strictEqual(saveTraces.length, 1);
  });

  await t.test('provides metrics summary', () => {
    const collector = new TraceCollector();
    const context = new OperationContext('corr-123', 'user-1', 'test_op');
    context.complete('success');
    collector.recordTrace(context);

    const summary = collector.getMetricsSummary();
    assert.strictEqual(summary.totalTraces, 1);
    assert.ok(summary.totalMetrics > 0);
    assert.ok(summary.operationTypes.includes('test_op'));
    assert.ok(summary.performanceStats.test_op);
  });

  await t.test('limits trace storage', () => {
    const collector = new TraceCollector();

    for (let i = 0; i < 5100; i++) {
      const context = new OperationContext(`corr-${i}`, 'user-1', 'op');
      context.complete('success');
      collector.recordTrace(context);
    }

    assert.ok(collector.traces.size <= 5000);
  });
});

test('FailClosedTracker', async (t) => {
  await t.test('defines checkpoints', () => {
    const tracker = new FailClosedTracker();
    tracker.defineCheckpoint('auth', 'User authentication', (ctx) => ({ passed: true }));

    const defs = tracker.checkpointDefinitions;
    assert.ok(defs.has('auth'));
    assert.strictEqual(defs.get('auth').name, 'auth');
  });

  await t.test('verifies checkpoints', () => {
    const tracker = new FailClosedTracker();
    tracker.defineCheckpoint('auth', 'Auth check', (ctx) => ({
      passed: ctx.userId !== null,
      reason: ctx.userId ? null : 'No user ID'
    }));

    const context = new OperationContext('corr-123', 'user-1', 'op');
    const result = tracker.verifyCheckpoint('auth', context);

    assert.ok(result.passed);
    assert.strictEqual(result.checkpointName, 'auth');
  });

  await t.test('tracks checkpoint violations', () => {
    const tracker = new FailClosedTracker();
    tracker.defineCheckpoint('data_validation', 'Data validation', (ctx) => ({
      passed: false,
      reason: 'Invalid data format'
    }));

    const context = new OperationContext('corr-123', 'user-1', 'op');
    tracker.verifyCheckpoint('data_validation', context);

    const violations = tracker.getViolations();
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].checkpoint, 'data_validation');
  });

  await t.test('provides checkpoint statistics', () => {
    const tracker = new FailClosedTracker();
    tracker.defineCheckpoint('check1', 'Check 1', (ctx) => ({ passed: true }));
    tracker.defineCheckpoint('check2', 'Check 2', (ctx) => ({ passed: false, reason: 'Failed' }));

    const context = new OperationContext('corr-123', 'user-1', 'op');
    tracker.verifyCheckpoint('check1', context);
    tracker.verifyCheckpoint('check2', context);

    const stats = tracker.getStats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.passed, 1);
    assert.strictEqual(stats.failed, 1);
  });

  await t.test('handles undefined checkpoints', () => {
    const tracker = new FailClosedTracker();
    const context = new OperationContext('corr-123', 'user-1', 'op');

    assert.throws(() => {
      tracker.verifyCheckpoint('undefined_checkpoint', context);
    }, /Checkpoint not defined/);
  });
});

test('DistributedTracer', async (t) => {
  await t.test('starts and ends traces', () => {
    const tracer = new DistributedTracer();
    const context = tracer.startTrace('user-1', 'fetch_op');

    assert.ok(context);
    assert.strictEqual(context.userId, 'user-1');
    assert.strictEqual(context.operationType, 'fetch_op');
    assert.strictEqual(tracer.propagator.getStackDepth(), 1);

    const summary = tracer.endTrace('success');
    assert.strictEqual(summary.status, 'success');
    assert.strictEqual(tracer.propagator.getStackDepth(), 0);
  });

  await t.test('executes traced operations', async () => {
    const tracer = new DistributedTracer();

    const result = await tracer.executeTracedOperation('user-1', 'test_op', async (ctx) => {
      ctx.recordTracePoint('component', 'event');
      return 'operation_result';
    });

    assert.strictEqual(result, 'operation_result');
    assert.strictEqual(tracer.propagator.getStackDepth(), 0);
  });

  await t.test('records trace points in current context', () => {
    const tracer = new DistributedTracer();
    const context = tracer.startTrace('user-1', 'op');

    tracer.recordTracePoint('component_a', 'started');
    tracer.recordTracePoint('component_b', 'completed', { info: 'test' });

    assert.strictEqual(context.tracePoints.length, 2);

    tracer.endTrace('success');
  });

  await t.test('defines and verifies Fail-Closed checkpoints', () => {
    const tracer = new DistributedTracer();
    tracer.failClosedTracker.defineCheckpoint('security_check', 'Security validation', (ctx) => ({
      passed: true,
      reason: null
    }));

    const context = tracer.startTrace('user-1', 'secure_op');
    const result = tracer.verifyCheckpoint('security_check');

    assert.ok(result.passed);
    tracer.endTrace('success');
  });

  await t.test('provides comprehensive diagnostics', () => {
    const tracer = new DistributedTracer();

    tracer.startTrace('user-1', 'op-1');
    tracer.recordTracePoint('comp', 'event');
    tracer.endTrace('success');

    const diag = tracer.getDiagnostics();
    assert.ok(diag.correlationIds > 0);
    assert.ok(diag.traces);
    assert.ok(diag.failClosed);
  });

  await t.test('handles errors in executeTracedOperation', async () => {
    const tracer = new DistributedTracer();

    try {
      await tracer.executeTracedOperation('user-1', 'failing_op', async () => {
        throw new Error('Operation failed');
      });
      assert.fail('Should have thrown');
    } catch (error) {
      assert.strictEqual(error.message, 'Operation failed');
    }

    // Context should still be cleaned up (popped)
    assert.strictEqual(tracer.propagator.getStackDepth(), 0);
  });

  await t.test('rejects endTrace without active context', () => {
    const tracer = new DistributedTracer();

    assert.throws(() => {
      tracer.endTrace('success');
    }, /No active context/);
  });

  await t.test('rejects checkpoint verification without active context', () => {
    const tracer = new DistributedTracer();
    tracer.failClosedTracker.defineCheckpoint('check', 'Check', (ctx) => ({ passed: true }));

    assert.throws(() => {
      tracer.verifyCheckpoint('check');
    }, /No active context/);
  });
});

test('Integration: Distributed Tracing Workflow', async (t) => {
  await t.test('complete tracing flow with multiple operations', async () => {
    const tracer = new DistributedTracer();

    // Operation 1: Top-level operation
    const op1Result = await tracer.executeTracedOperation('user-1', 'fetch_data', async (ctx) => {
      ctx.recordTracePoint('api', 'request_sent');

      // Simulate nested operation via child context
      const childCtx = ctx.createChild('process_data');
      childCtx.recordTracePoint('processor', 'processing');
      childCtx.recordFailClosedCheckpoint('validation', true);
      childCtx.complete('success');

      ctx.recordTracePoint('api', 'response_received');
      return { data: 'result' };
    });

    assert.ok(op1Result);

    // Operation 2: Different operation type
    await tracer.executeTracedOperation('user-1', 'save_data', async (ctx) => {
      ctx.recordTracePoint('storage', 'writing');
    });

    const diag = tracer.getDiagnostics();
    assert.ok(diag.traces.performanceStats.fetch_data);
    assert.ok(diag.traces.performanceStats.save_data);
  });

  await t.test('Fail-Closed checkpoint enforcement', async () => {
    const tracer = new DistributedTracer();

    // Define security checkpoints
    tracer.failClosedTracker.defineCheckpoint('authentication', 'User must be authenticated', (ctx) => ({
      passed: ctx.userId !== 'anonymous',
      reason: ctx.userId === 'anonymous' ? 'Unauthenticated user' : null
    }));

    tracer.failClosedTracker.defineCheckpoint('authorization', 'User must have permission', (ctx) => ({
      passed: true,
      reason: null
    }));

    // Trace operation with checkpoints
    const context = tracer.startTrace('authenticated_user', 'secure_operation');
    tracer.recordTracePoint('security', 'started');

    const authResult = tracer.verifyCheckpoint('authentication');
    assert.ok(authResult.passed);

    const authzResult = tracer.verifyCheckpoint('authorization');
    assert.ok(authzResult.passed);

    tracer.recordTracePoint('security', 'completed');
    tracer.endTrace('success');

    // Verify checkpoints recorded in context
    assert.strictEqual(context.failClosedCheckpoints.length, 2);
  });

  await t.test('trace collection and statistics', () => {
    const tracer = new DistributedTracer();

    // Generate multiple traces
    for (let i = 0; i < 5; i++) {
      tracer.startTrace(`user-${i}`, 'batch_operation');
      tracer.recordTracePoint('worker', `processing_item_${i}`);
      tracer.endTrace('success');
    }

    const metrics = tracer.traceCollector.getMetricsSummary();
    assert.strictEqual(metrics.totalTraces, 5);
    assert.ok(metrics.performanceStats.batch_operation.avgDuration >= 0);
  });
});
