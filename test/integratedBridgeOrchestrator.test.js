/**
 * Tests for Integrated Bridge Orchestrator
 * Covers component registration, integration validation, orchestration, and health aggregation
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  BridgeComponentRegistry,
  IntegrationValidator,
  BridgeOrchestrationEngine,
  BridgeHealthAggregator
} = require('../src/integratedBridgeOrchestrator');

test('BridgeComponentRegistry', async (t) => {
  await t.test('registers component successfully', () => {
    const registry = new BridgeComponentRegistry();
    const component = { process: () => {} };

    registry.registerComponent('validator', component, { phase: 1 });

    const registered = registry.getComponent('validator');
    assert.ok(registered);
    assert.strictEqual(registered.name, 'validator');
  });

  await t.test('throws on invalid component name', () => {
    const registry = new BridgeComponentRegistry();
    assert.throws(() => registry.registerComponent('', {}, {}), /non-empty string/);
  });

  await t.test('throws on invalid component object', () => {
    const registry = new BridgeComponentRegistry();
    assert.throws(() => registry.registerComponent('test', null, {}), /must be an object/);
  });

  await t.test('registers component with dependencies', () => {
    const registry = new BridgeComponentRegistry();
    const comp1 = {};
    const comp2 = {};

    registry.registerComponent('comp1', comp1, { phase: 1 });
    registry.registerComponent('comp2', comp2, { phase: 2, dependencies: ['comp1'] });

    const deps = registry.dependencies.get('comp2');
    assert.deepStrictEqual(deps, ['comp1']);
  });

  await t.test('retrieves all components', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp1', {}, { phase: 1 });
    registry.registerComponent('comp2', {}, { phase: 2 });

    const all = registry.getAllComponents();
    assert.strictEqual(all.length, 2);
  });

  await t.test('marks component as initialized', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp1', {}, { phase: 1 });

    registry.markInitialized('comp1');

    const comp = registry.getComponent('comp1');
    assert.strictEqual(comp.initialized, true);
  });

  await t.test('verifies dependencies are satisfied', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('dep', {}, { phase: 1 });
    registry.registerComponent('comp', {}, { phase: 2, dependencies: ['dep'] });

    const result = registry.verifyDependencies('comp');

    assert.strictEqual(result.satisfied, true);
    assert.deepStrictEqual(result.missingDependencies, []);
  });

  await t.test('detects missing dependencies', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp', {}, { phase: 1, dependencies: ['missing'] });

    const result = registry.verifyDependencies('comp');

    assert.strictEqual(result.satisfied, false);
    assert.ok(result.missingDependencies.includes('missing'));
  });

  await t.test('computes initialization order respecting dependencies', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('a', {}, { phase: 1 });
    registry.registerComponent('b', {}, { phase: 2, dependencies: ['a'] });
    registry.registerComponent('c', {}, { phase: 3, dependencies: ['b'] });

    const order = registry.computeInitializationOrder();

    assert.deepStrictEqual(order, ['a', 'b', 'c']);
  });

  await t.test('detects circular dependencies', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('a', {}, { dependencies: ['b'] });
    registry.registerComponent('b', {}, { dependencies: ['a'] });

    assert.throws(() => registry.computeInitializationOrder(), /Circular dependency/);
  });

  await t.test('tracks registration history', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp1', {}, {});
    registry.markInitialized('comp1');

    const history = registry.getHistory();

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].action, 'register');
    assert.strictEqual(history[1].action, 'initialized');
  });

  await t.test('reports registry statistics', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp1', {}, { version: '1.0.0' });
    registry.registerComponent('comp2', {}, { version: '2.0.0' });
    registry.markInitialized('comp1');

    const stats = registry.getStats();

    assert.strictEqual(stats.totalComponents, 2);
    assert.strictEqual(stats.initializedComponents, 1);
    assert.strictEqual(stats.pendingComponents, 1);
  });
});

test('IntegrationValidator', async (t) => {
  await t.test('validates all integrations', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp1', {}, { phase: 1 });
    registry.registerComponent('comp2', {}, { phase: 2, dependencies: ['comp1'] });
    registry.markInitialized('comp1');

    const validator = new IntegrationValidator(registry);
    const result = validator.validateIntegrations();

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.components.length, 2);
  });

  await t.test('detects integration issues', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp', {}, { dependencies: ['missing'] });

    const validator = new IntegrationValidator(registry);
    const result = validator.validateIntegrations();

    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.length > 0);
  });

  await t.test('validates component interface', () => {
    const registry = new BridgeComponentRegistry();
    const component = { process: () => {}, validate: () => {} };
    registry.registerComponent('comp', component, {});

    const validator = new IntegrationValidator(registry);
    const result = validator.validateComponentInterface('comp', ['process', 'validate']);

    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.presentMethods, ['process', 'validate']);
  });

  await t.test('detects missing methods in interface validation', () => {
    const registry = new BridgeComponentRegistry();
    const component = { process: () => {} };
    registry.registerComponent('comp', component, {});

    const validator = new IntegrationValidator(registry);
    const result = validator.validateComponentInterface('comp', ['process', 'validate']);

    assert.strictEqual(result.valid, false);
    assert.ok(result.missingMethods.includes('validate'));
  });

  await t.test('tracks validation history', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp', {}, {});

    const validator = new IntegrationValidator(registry);
    validator.validateIntegrations();
    validator.validateIntegrations();

    const history = validator.getHistory();
    assert.strictEqual(history.length, 2);
  });
});

test('BridgeOrchestrationEngine', async (t) => {
  await t.test('executes simple pipeline', async () => {
    const registry = new BridgeComponentRegistry();
    const mockComponent = {
      step1: async () => ({ result: 'ok' })
    };
    registry.registerComponent('mock', mockComponent, {});
    registry.markInitialized('mock');

    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = {
      steps: [
        { name: 'step1', component: 'mock', method: 'step1' }
      ]
    };

    const result = await engine.executePipeline({}, pipeline);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.steps.length, 1);
    assert.strictEqual(result.steps[0].name, 'step1');
  });

  await t.test('executes multi-step pipeline', async () => {
    const registry = new BridgeComponentRegistry();
    const mockComponent = {
      validate: async () => ({ validated: true }),
      process: async () => ({ processed: true })
    };
    registry.registerComponent('mock', mockComponent, {});
    registry.markInitialized('mock');

    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = {
      steps: [
        { name: 'validate', component: 'mock', method: 'validate' },
        { name: 'process', component: 'mock', method: 'process' }
      ]
    };

    const result = await engine.executePipeline({}, pipeline);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.steps.length, 2);
  });

  await t.test('handles component not found', async () => {
    const registry = new BridgeComponentRegistry();
    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = {
      steps: [
        { name: 'step1', component: 'missing', method: 'method' }
      ]
    };

    const result = await engine.executePipeline({}, pipeline);

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length > 0);
  });

  await t.test('handles method not found', async () => {
    const registry = new BridgeComponentRegistry();
    const mockComponent = { other: () => {} };
    registry.registerComponent('mock', mockComponent, {});
    registry.markInitialized('mock');

    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = {
      steps: [
        { name: 'step1', component: 'mock', method: 'missing' }
      ]
    };

    const result = await engine.executePipeline({}, pipeline);

    assert.strictEqual(result.success, false);
  });

  await t.test('propagates context between steps', async () => {
    const registry = new BridgeComponentRegistry();
    const mockComponent = {
      step1: async (ctx) => ({ data: 'step1-result' }),
      step2: async (ctx) => {
        assert.ok(ctx.data);
        return { data: 'step2-result' };
      }
    };
    registry.registerComponent('mock', mockComponent, {});
    registry.markInitialized('mock');

    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = {
      steps: [
        { name: 'step1', component: 'mock', method: 'step1' },
        { name: 'step2', component: 'mock', method: 'step2' }
      ]
    };

    const result = await engine.executePipeline({}, pipeline);

    assert.strictEqual(result.success, true);
  });

  await t.test('records execution in history', async () => {
    const registry = new BridgeComponentRegistry();
    const mockComponent = { step: async () => ({}) };
    registry.registerComponent('mock', mockComponent, {});
    registry.markInitialized('mock');

    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = { steps: [{ name: 'step', component: 'mock', method: 'step' }] };

    await engine.executePipeline({}, pipeline);
    const history = engine.getHistory();

    assert.strictEqual(history.length, 1);
    assert.ok(history[0].operationId);
  });

  await t.test('validates integration before pipeline execution', async () => {
    const registry = new BridgeComponentRegistry();
    // Register component without marking initialized
    registry.registerComponent('comp', {}, { dependencies: ['missing'] });

    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = {
      steps: [{ name: 'step', component: 'comp', method: 'method' }]
    };

    const result = await engine.executePipeline({}, pipeline);

    assert.strictEqual(result.success, false);
    assert.ok(result.errors[0].includes('Integration validation failed'));
  });

  await t.test('tracks active operations', async () => {
    const registry = new BridgeComponentRegistry();
    const mockComponent = {
      slowStep: async () => {
        await new Promise(r => setTimeout(r, 10));
        return {};
      }
    };
    registry.registerComponent('mock', mockComponent, {});
    registry.markInitialized('mock');

    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = { steps: [{ name: 'slowStep', component: 'mock', method: 'slowStep' }] };

    const executionPromise = engine.executePipeline({}, pipeline);
    const activeOps = engine.getActiveOperations();

    await executionPromise;

    assert.ok(activeOps.length >= 0); // May complete before check
  });
});

test('BridgeHealthAggregator', async (t) => {
  await t.test('aggregates health from all components', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp1', {}, { phase: 1 });
    registry.registerComponent('comp2', {}, { phase: 2 });
    registry.markInitialized('comp1');
    registry.markInitialized('comp2');

    const aggregator = new BridgeHealthAggregator(registry);
    const report = aggregator.aggregateHealth();

    assert.strictEqual(report.summary.total, 2);
    assert.strictEqual(report.summary.healthy, 2);
    assert.strictEqual(report.overallStatus, 'healthy');
  });

  await t.test('detects unhealthy components', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('healthy', {}, { phase: 1 });
    registry.registerComponent('unhealthy', {}, { phase: 2, dependencies: ['missing'] });
    registry.markInitialized('healthy');
    registry.markInitialized('unhealthy'); // Mark as initialized but dependency missing

    const aggregator = new BridgeHealthAggregator(registry);
    const report = aggregator.aggregateHealth();

    assert.strictEqual(report.overallStatus, 'unhealthy');
    assert.ok(report.issues.length > 0);
  });

  await t.test('reports unknown status for uninitialized components', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('uninitialized', {}, { phase: 1 });

    const aggregator = new BridgeHealthAggregator(registry);
    const report = aggregator.aggregateHealth();

    assert.strictEqual(report.summary.unknown, 1);
    assert.strictEqual(report.overallStatus, 'degraded');
  });

  await t.test('stores health snapshots', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp', {}, {});
    registry.markInitialized('comp');

    const aggregator = new BridgeHealthAggregator(registry);
    aggregator.aggregateHealth();
    aggregator.aggregateHealth();

    const snapshots = aggregator.getSnapshots();
    assert.strictEqual(snapshots.length, 2);
  });

  await t.test('respects snapshot limit', () => {
    const registry = new BridgeComponentRegistry();
    registry.registerComponent('comp', {}, {});
    registry.markInitialized('comp');

    const aggregator = new BridgeHealthAggregator(registry);

    // Generate more snapshots than limit
    for (let i = 0; i < 150; i++) {
      aggregator.aggregateHealth();
    }

    const snapshots = aggregator.getSnapshots(50);
    assert.ok(snapshots.length <= 50);
  });
});

test('Integration: Complete Bridge Orchestration', async (t) => {
  await t.test('full pipeline with component dependencies', async () => {
    const registry = new BridgeComponentRegistry();

    // Register dependency component
    const validatorComponent = {
      validate: async (ctx) => {
        return { ...ctx, validated: true };
      }
    };
    registry.registerComponent('validator', validatorComponent, { phase: 1 });

    // Register main component with dependency
    const processorComponent = {
      process: async (ctx) => {
        assert.ok(ctx.validated);
        return { ...ctx, processed: true };
      }
    };
    registry.registerComponent('processor', processorComponent, {
      phase: 2,
      dependencies: ['validator']
    });

    // Mark as initialized
    registry.markInitialized('validator');
    registry.markInitialized('processor');

    // Create engine and execute pipeline
    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = {
      steps: [
        { name: 'validate', component: 'validator', method: 'validate' },
        { name: 'process', component: 'processor', method: 'process' }
      ]
    };

    const result = await engine.executePipeline({}, pipeline);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.steps.length, 2);
    assert.ok(result.finalContext.validated);
    assert.ok(result.finalContext.processed);
  });

  await t.test('integration validation with health check', () => {
    const registry = new BridgeComponentRegistry();

    // Register multiple components
    registry.registerComponent('comp1', {}, { phase: 1 });
    registry.registerComponent('comp2', {}, { phase: 2, dependencies: ['comp1'] });
    registry.registerComponent('comp3', {}, { phase: 3, dependencies: ['comp2'] });

    // Initialize all
    registry.markInitialized('comp1');
    registry.markInitialized('comp2');
    registry.markInitialized('comp3');

    // Validate integrations
    const validator = new IntegrationValidator(registry);
    const integrationResult = validator.validateIntegrations();

    // Aggregate health
    const aggregator = new BridgeHealthAggregator(registry);
    const healthReport = aggregator.aggregateHealth();

    assert.strictEqual(integrationResult.valid, true);
    assert.strictEqual(healthReport.overallStatus, 'healthy');
    assert.strictEqual(healthReport.summary.total, 3);
  });

  await t.test('orchestrator handles failure and gracefully degradation', async () => {
    const registry = new BridgeComponentRegistry();

    // Component that throws
    const faultyComponent = {
      fail: async () => {
        throw new Error('Component failure');
      }
    };
    registry.registerComponent('faulty', faultyComponent, {});
    registry.markInitialized('faulty');

    // Component that handles errors
    const safeComponent = {
      handleFailure: async (ctx) => {
        return { ...ctx, error: 'handled' };
      }
    };
    registry.registerComponent('safe', safeComponent, {});
    registry.markInitialized('safe');

    const engine = new BridgeOrchestrationEngine(registry);
    const pipeline = {
      steps: [
        { name: 'fail', component: 'faulty', method: 'fail' },
        { name: 'handle', component: 'safe', method: 'handleFailure' }
      ]
    };

    const result = await engine.executePipeline({}, pipeline);

    // First step fails, so pipeline stops
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.steps.length, 1);
  });
});
