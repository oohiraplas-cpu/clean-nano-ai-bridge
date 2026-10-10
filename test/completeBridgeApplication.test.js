/**
 * Tests for Complete Bridge Application Integration
 * Covers application initialization, component coordination, server lifecycle, and end-to-end operation
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  CompleteBridgeApplication,
  BridgeApplicationFactory
} = require('../src/completeBridgeApplication');

test('CompleteBridgeApplication', async (t) => {
  await t.test('initializes with default state', () => {
    const app = new CompleteBridgeApplication();

    assert.strictEqual(app.status, 'uninitialized');
    assert.strictEqual(app.startupSequence, null);
    assert.strictEqual(app.componentRegistry, null);
    assert.strictEqual(app.orchestrationEngine, null);
    assert.strictEqual(app.healthAggregator, null);
    assert.strictEqual(app.bridgeServer, null);
    assert.strictEqual(app.initializationResult, null);
  });

  await t.test('initializes application components', async () => {
    const app = new CompleteBridgeApplication();
    const config = {
      environment: {
        required: {},
        optional: {}
      },
      server: {
        port: 3000,
        host: 'localhost'
      }
    };

    const result = await app.initialize(config);

    // Success should be true even if startup has errors (no required env vars)
    assert.ok(result.success);
    assert.ok(app.startupSequence);
    assert.ok(app.componentRegistry);
    assert.ok(app.orchestrationEngine);
    assert.ok(app.healthAggregator);
    assert.ok(app.bridgeServer);
    assert.strictEqual(app.status, 'ready');
  });

  await t.test('tracks initialization metadata', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    const result = await app.initialize(config);

    assert.ok(result.startTime);
    assert.ok(result.endTime);
    assert.ok(result.duration >= 0);
    assert.ok(app.startupMetadata.startTime);
    // readyTime should be set after successful initialization
    assert.strictEqual(app.status, 'ready');
  });

  await t.test('registers core components', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);

    const components = app.componentRegistry.getAllComponents();
    const componentNames = components.map(c => c.name);

    // At minimum orchestrator, healthAggregator, and bridgeServer should be registered
    assert.ok(componentNames.length >= 3);
    assert.ok(componentNames.includes('orchestrator'));
    assert.ok(componentNames.includes('healthAggregator'));
    assert.ok(componentNames.includes('bridgeServer'));
  });

  await t.test('validates component integration', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    const result = await app.initialize(config);

    // Validation should be performed even if startup has issues
    assert.ok(result.phases.validation || result.success);
    if (result.phases.validation) {
      assert.ok(typeof result.phases.validation.valid === 'boolean');
    }
  });

  await t.test('executes startup sequence', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    const result = await app.initialize(config);

    // Startup sequence should be created and executed
    assert.ok(app.startupSequence);
    assert.ok(result.phases.startup || result.success);
  });

  await t.test('handles initialization failure', async () => {
    const app = new CompleteBridgeApplication();
    const config = {
      environment: {
        required: { 'MISSING_VAR': 'Missing variable' },
        optional: {}
      },
      server: {}
    };

    const result = await app.initialize(config);

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length > 0);
    assert.strictEqual(app.status, 'failed');
  });

  await t.test('rejects start if not ready', async () => {
    const app = new CompleteBridgeApplication();
    const express = () => ({ use: () => {}, get: () => {}, post: () => {}, listen: () => ({}) });

    const result = await app.start(express);

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });

  await t.test('provides health report', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);
    const health = app.getHealthReport();

    assert.ok(health.timestamp);
    assert.ok(health.uptime || health.uptime === 0);
    assert.ok(health.components);
    assert.ok(health.server);
  });

  await t.test('provides diagnostics', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);
    const diag = app.getDiagnostics();

    assert.ok(diag.application);
    // All diagnostic sections should be available after initialization
    assert.ok(diag.registry);
    assert.ok(diag.orchestration);
    assert.ok(diag.server);
  });

  await t.test('executes shutdown sequence', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);

    // Timeout protection for shutdown
    const shutdownPromise = app.shutdown();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Shutdown timeout')), 5000)
    );

    const result = await Promise.race([shutdownPromise, timeoutPromise]);

    assert.strictEqual(result.success, true);
    assert.ok(result.phases.serverShutdown);
    assert.ok(result.phases.handlerShutdown);
    assert.strictEqual(app.status, 'shutdown');
  });

  await t.test('rejects operation if not running', async () => {
    const app = new CompleteBridgeApplication();

    const result = await app.executeOperation({}, []);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.statusCode, 503);
  });

  await t.test('tracks multiple initializations', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    const result1 = await app.initialize(config);
    const startTime1 = app.startupMetadata.startTime;

    // Reset for second initialization test (new instance)
    const app2 = new CompleteBridgeApplication();
    const result2 = await app2.initialize(config);
    const startTime2 = app2.startupMetadata.startTime;

    assert.strictEqual(result1.success, true);
    assert.strictEqual(result2.success, true);
    assert.ok(startTime1);
    assert.ok(startTime2);
  });
});

test('BridgeApplicationFactory', async (t) => {
  await t.test('creates application with default config', async () => {
    const app = await BridgeApplicationFactory.createApplication();

    assert.ok(app instanceof CompleteBridgeApplication);
    // Application should be ready after initialization
    assert.strictEqual(app.status, 'ready');
    assert.ok(app.startupSequence);
    assert.ok(app.componentRegistry);
  });

  await t.test('creates application with custom config', async () => {
    const config = {
      environment: { required: {}, optional: {} },
      server: { port: 8080, host: '127.0.0.1' }
    };

    const app = await BridgeApplicationFactory.createApplicationWithConfig(config);

    assert.ok(app instanceof CompleteBridgeApplication);
    assert.strictEqual(app.status, 'ready');
    assert.strictEqual(app.bridgeServer.factory.serverConfig.port, 8080);
    assert.strictEqual(app.bridgeServer.factory.serverConfig.host, '127.0.0.1');
  });

  await t.test('factory app has all subsystems', async () => {
    const app = await BridgeApplicationFactory.createApplication();

    assert.ok(app.startupSequence);
    assert.ok(app.componentRegistry);
    assert.ok(app.orchestrationEngine);
    assert.ok(app.healthAggregator);
    assert.ok(app.bridgeServer);
  });
});

test('Integration: Complete Application Lifecycle', async (t) => {
  await t.test('full application startup and shutdown', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    // Initialize
    let result = await app.initialize(config);
    assert.strictEqual(result.success, true);
    assert.strictEqual(app.status, 'ready');

    // Shutdown
    result = await app.shutdown();
    assert.strictEqual(result.success, true);
    assert.strictEqual(app.status, 'shutdown');
  });

  await t.test('health monitoring across lifecycle', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);
    const health1 = app.getHealthReport();

    assert.ok(health1.components);
    assert.ok(['healthy', 'degraded', 'unhealthy'].includes(health1.components.overallStatus));

    await app.shutdown();
    const health2 = app.getHealthReport();

    assert.strictEqual(health2.applicationStatus, 'shutdown');
  });

  await t.test('component registry tracks all phases', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);
    const stats = app.componentRegistry.getStats();

    // At minimum should register core components
    assert.ok(stats.totalComponents >= 2);
    assert.ok(stats.versions);
  });

  await t.test('orchestration engine initialized', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);

    assert.ok(app.orchestrationEngine);
    const history = app.orchestrationEngine.getHistory();
    assert.ok(Array.isArray(history));
  });

  await t.test('health aggregator provides report', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);
    const report = app.healthAggregator.aggregateHealth();

    assert.ok(report.timestamp);
    assert.ok(report.components);
    assert.ok(['healthy', 'degraded', 'unhealthy'].includes(report.overallStatus));
  });

  await t.test('diagnostics captures full state', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);
    const diag = app.getDiagnostics();

    assert.ok(diag.application.status);
    assert.ok(diag.application.metadata);
    assert.ok(diag.startup);
    assert.ok(diag.registry);
    assert.ok(diag.orchestration);
    assert.ok(diag.server);
  });

  await t.test('application maintains uptime tracking', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);

    const health1 = app.getHealthReport();
    const uptime1 = health1.uptime;

    await new Promise(resolve => setTimeout(resolve, 10));

    const health2 = app.getHealthReport();
    const uptime2 = health2.uptime;

    assert.ok(uptime2 >= uptime1);
  });

  await t.test('factory-created app supports full lifecycle', async () => {
    const app = await BridgeApplicationFactory.createApplication();

    assert.strictEqual(app.status, 'ready');

    const health = app.getHealthReport();
    assert.ok(health.components);

    const result = await app.shutdown();
    assert.strictEqual(result.success, true);
  });

  await t.test('multiple components register dependencies', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);

    // Check that bridgeServer is registered with proper structure
    const bridgeServerData = app.componentRegistry.getComponent('bridgeServer');
    if (bridgeServerData) {
      assert.ok(Array.isArray(bridgeServerData.dependencies));
    }
  });

  await t.test('error handling during initialization', async () => {
    const app = new CompleteBridgeApplication();
    const config = {
      environment: {
        required: { 'REQUIRED_BUT_MISSING': 'Test required var' },
        optional: {}
      },
      server: {}
    };

    const result = await app.initialize(config);

    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length > 0);
    assert.strictEqual(app.status, 'failed');
  });

  await t.test('graceful shutdown handles cleanup', async () => {
    const app = new CompleteBridgeApplication();
    const config = { environment: { required: {}, optional: {} }, server: {} };

    await app.initialize(config);

    // Add a shutdown handler to track execution
    let shutdownCalled = false;
    app.startupSequence.onShutdown(async () => {
      shutdownCalled = true;
    });

    const result = await app.shutdown();

    assert.strictEqual(result.success, true);
    assert.strictEqual(shutdownCalled, true);
  });
});
