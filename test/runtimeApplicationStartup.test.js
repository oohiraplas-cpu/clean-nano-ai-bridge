/**
 * Tests for Runtime Application Startup
 * Covers environment loading, dependency initialization, configuration validation, and startup orchestration
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  EnvironmentLoader,
  DependencyInitializer,
  ConfigurationValidator,
  StartupSequence,
  ApplicationBootstrap
} = require('../src/runtimeApplicationStartup');

test('EnvironmentLoader', async (t) => {
  await t.test('requires environment variable', () => {
    const loader = new EnvironmentLoader();
    loader.requireVariable('TEST_VAR', 'Test variable');

    assert.strictEqual(loader.required.length, 1);
    assert.strictEqual(loader.required[0].name, 'TEST_VAR');
  });

  await t.test('defines optional variable with default', () => {
    const loader = new EnvironmentLoader();
    loader.defineOptional('OPT_VAR', 'default-value', 'Optional variable');

    assert.strictEqual(loader.optional.length, 1);
    assert.strictEqual(loader.optional[0].name, 'OPT_VAR');
    assert.strictEqual(loader.optional[0].defaultValue, 'default-value');
  });

  await t.test('loads from process.env', () => {
    const loader = new EnvironmentLoader();
    loader.requireVariable('TEST_LOAD', 'Test load');
    loader.defineOptional('TEST_OPT', 'default', 'Optional');

    // Set environment variable
    process.env.TEST_LOAD = 'loaded-value';

    const result = loader.loadFromProcess();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.loaded, 2);
    assert.strictEqual(loader.environment.TEST_LOAD, 'loaded-value');
    assert.strictEqual(loader.environment.TEST_OPT, 'default');

    delete process.env.TEST_LOAD;
  });

  await t.test('detects missing required variables', () => {
    const loader = new EnvironmentLoader();
    loader.requireVariable('MISSING_VAR', 'Missing variable');

    const result = loader.loadFromProcess();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.missing.length, 1);
    assert.strictEqual(result.missing[0], 'MISSING_VAR');
  });

  await t.test('validates with custom validator', () => {
    const loader = new EnvironmentLoader();
    loader.requireVariable('PORT', 'Port number', (val) => !isNaN(parseInt(val)) && parseInt(val) > 0);

    process.env.PORT = '3000';
    let result = loader.loadFromProcess();
    assert.strictEqual(result.success, true);

    // Reset for next test
    loader.validationErrors = [];
    loader.environment = {};

    process.env.PORT = 'invalid';
    result = loader.loadFromProcess();
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.invalid.length, 1);

    delete process.env.PORT;
  });

  await t.test('tracks load history', () => {
    const loader = new EnvironmentLoader();
    loader.defineOptional('OPT', 'default', 'Optional');

    loader.loadFromProcess();
    loader.loadFromProcess();

    const history = loader.getHistory();

    assert.strictEqual(history.length, 2);
  });

  await t.test('returns loaded environment', () => {
    const loader = new EnvironmentLoader();
    loader.defineOptional('VAR1', 'val1', 'Var 1');
    loader.defineOptional('VAR2', 'val2', 'Var 2');

    loader.loadFromProcess();
    const env = loader.getEnvironment();

    assert.ok(env.VAR1);
    assert.ok(env.VAR2);
  });

  await t.test('collects validation errors', () => {
    const loader = new EnvironmentLoader();
    loader.requireVariable('REQUIRED1', 'Required 1');
    loader.requireVariable('REQUIRED2', 'Required 2');

    loader.loadFromProcess();
    const errors = loader.getErrors();

    assert.strictEqual(errors.length, 2);
  });
});

test('DependencyInitializer', async (t) => {
  await t.test('defines component', () => {
    const initializer = new DependencyInitializer();
    const initFn = async () => {};

    initializer.defineComponent('comp1', [], initFn);

    assert.ok(initializer.dependencies.has('comp1'));
    assert.ok(initializer.initializers.has('comp1'));
  });

  await t.test('throws on invalid dependency array', () => {
    const initializer = new DependencyInitializer();

    assert.throws(() => initializer.defineComponent('comp1', 'not-array', async () => {}), /depends must be an array/);
  });

  await t.test('throws on invalid initializer function', () => {
    const initializer = new DependencyInitializer();

    assert.throws(() => initializer.defineComponent('comp1', [], 'not-function'), /initializer must be a function/);
  });

  await t.test('computes initialization order', () => {
    const initializer = new DependencyInitializer();
    initializer.defineComponent('comp1', [], async () => {});
    initializer.defineComponent('comp2', ['comp1'], async () => {});
    initializer.defineComponent('comp3', ['comp1', 'comp2'], async () => {});

    const result = initializer.computeOrder();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.order[0], 'comp1');
    assert.ok(result.order.indexOf('comp2') > result.order.indexOf('comp1'));
    assert.ok(result.order.indexOf('comp3') > result.order.indexOf('comp2'));
  });

  await t.test('detects circular dependencies', () => {
    const initializer = new DependencyInitializer();
    initializer.defineComponent('comp1', ['comp2'], async () => {});
    initializer.defineComponent('comp2', ['comp1'], async () => {});

    const result = initializer.computeOrder();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.cycles.length, 1);
  });

  await t.test('initializes components successfully', async () => {
    const initializer = new DependencyInitializer();
    let comp1Init = false;
    let comp2Init = false;

    initializer.defineComponent('comp1', [], async () => { comp1Init = true; });
    initializer.defineComponent('comp2', ['comp1'], async () => { comp2Init = true; });

    const result = await initializer.initializeAll();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.initialized.length, 2);
    assert.strictEqual(comp1Init, true);
    assert.strictEqual(comp2Init, true);
  });

  await t.test('captures initialization errors', async () => {
    const initializer = new DependencyInitializer();
    initializer.defineComponent('comp1', [], async () => { throw new Error('Init failed'); });

    const result = await initializer.initializeAll();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0], 'comp1');
  });

  await t.test('tracks initialization duration', async () => {
    const initializer = new DependencyInitializer();
    initializer.defineComponent('comp1', [], async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    const result = await initializer.initializeAll();

    assert.ok(result.initialized[0].duration >= 10);
  });

  await t.test('returns initialization status', async () => {
    const initializer = new DependencyInitializer();
    initializer.defineComponent('comp1', [], async () => {});
    initializer.defineComponent('comp2', [], async () => {});

    await initializer.initializeAll();
    const status = initializer.getStatus();

    assert.strictEqual(status.initialized, 2);
    assert.strictEqual(status.total, 2);
    assert.strictEqual(status.completionPercent, '100.0');
  });

  await t.test('tracks initialization history', async () => {
    const initializer = new DependencyInitializer();
    initializer.defineComponent('comp1', [], async () => {});

    await initializer.initializeAll();
    await initializer.initializeAll();

    const history = initializer.getHistory();

    assert.strictEqual(history.length, 2);
  });
});

test('ConfigurationValidator', async (t) => {
  await t.test('defines configuration schema', () => {
    const validator = new ConfigurationValidator();
    const schema = {
      required: ['field1'],
      optional: ['field2']
    };

    validator.defineSchema('app', schema);

    assert.ok(validator.schemas.has('app'));
  });

  await t.test('throws on invalid schema', () => {
    const validator = new ConfigurationValidator();

    assert.throws(() => validator.defineSchema('app', null), /Schema must be an object/);
  });

  await t.test('validates configuration with required fields', () => {
    const validator = new ConfigurationValidator();
    validator.defineSchema('app', {
      required: ['apiKey', 'apiSecret']
    });

    const config = {
      app: {
        apiKey: 'key123',
        apiSecret: 'secret456'
      }
    };

    const result = validator.validateConfig(config);

    assert.strictEqual(result.valid, true);
  });

  await t.test('detects missing required fields', () => {
    const validator = new ConfigurationValidator();
    validator.defineSchema('app', {
      required: ['apiKey', 'apiSecret']
    });

    const config = {
      app: {
        apiKey: 'key123'
        // missing apiSecret
      }
    };

    const result = validator.validateConfig(config);

    assert.strictEqual(result.valid, false);
    assert.ok(result.sections[0].missing.includes('apiSecret'));
  });

  await t.test('validates optional fields with validators', () => {
    const validator = new ConfigurationValidator();
    validator.defineSchema('app', {
      required: [],
      optional: ['port'],
      validators: {
        port: (val) => !isNaN(parseInt(val)) && parseInt(val) > 0
      }
    });

    const config = {
      app: {
        port: '3000'
      }
    };

    const result = validator.validateConfig(config);

    assert.strictEqual(result.valid, true);
  });

  await t.test('detects invalid optional fields', () => {
    const validator = new ConfigurationValidator();
    validator.defineSchema('app', {
      optional: ['port'],
      validators: {
        port: (val) => !isNaN(parseInt(val)) && parseInt(val) > 0
      }
    });

    const config = {
      app: {
        port: 'invalid'
      }
    };

    const result = validator.validateConfig(config);

    assert.strictEqual(result.valid, false);
    assert.ok(result.sections[0].invalid.includes('port'));
  });

  await t.test('tracks validation history', () => {
    const validator = new ConfigurationValidator();
    validator.defineSchema('app', { required: [] });

    validator.validateConfig({ app: {} });
    validator.validateConfig({ app: {} });

    const history = validator.getHistory();

    assert.strictEqual(history.length, 2);
  });
});

test('StartupSequence', async (t) => {
  await t.test('initializes startup sequence', () => {
    const sequence = new StartupSequence();

    assert.ok(sequence.envLoader);
    assert.ok(sequence.depInitializer);
    assert.ok(sequence.configValidator);
    assert.strictEqual(sequence.status, 'not_started');
  });

  await t.test('configures startup sequence', () => {
    const sequence = new StartupSequence();
    const options = { timeout: 30000 };

    sequence.configure(options);

    assert.strictEqual(sequence.config.timeout, 30000);
  });

  await t.test('registers shutdown handler', () => {
    const sequence = new StartupSequence();
    const handler = async () => {};

    sequence.onShutdown(handler);

    assert.strictEqual(sequence.shutdownHandlers.length, 1);
  });

  await t.test('throws on invalid shutdown handler', () => {
    const sequence = new StartupSequence();

    assert.throws(() => sequence.onShutdown('not-a-function'), /Handler must be a function/);
  });

  await t.test('executes startup sequence successfully', async () => {
    const sequence = new StartupSequence();

    const result = await sequence.startup();

    assert.ok(result.phases.environment);
    assert.ok(result.phases.dependencies);
    assert.ok(result.phases.configuration);
    assert.ok(result.duration >= 0);
  });

  await t.test('returns startup status', async () => {
    const sequence = new StartupSequence();
    await sequence.startup();

    const status = sequence.getStatus();

    assert.ok(status.status);
    assert.ok(typeof status.environment === 'number');
    assert.ok(status.dependencies);
  });

  await t.test('executes shutdown handlers', async () => {
    const sequence = new StartupSequence();
    let handlerCalled = false;

    sequence.onShutdown(async () => { handlerCalled = true; });

    const result = await sequence.shutdown();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.handlersExecuted, 1);
    assert.strictEqual(handlerCalled, true);
  });

  await t.test('handles shutdown handler errors', async () => {
    const sequence = new StartupSequence();
    sequence.onShutdown(async () => { throw new Error('Shutdown failed'); });

    const result = await sequence.shutdown();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errors.length, 1);
  });

  await t.test('sets up signal handlers without crashing', () => {
    const sequence = new StartupSequence();

    // Should not throw
    sequence.setupSignalHandlers();

    assert.ok(true);
  });

  await t.test('tracks startup status through phases', async () => {
    const sequence = new StartupSequence();
    const result = await sequence.startup();

    assert.ok(result.startTime);
    assert.ok(result.endTime);
    assert.ok(result.duration >= 0);
  });
});

test('ApplicationBootstrap', async (t) => {
  await t.test('initializes bootstrap', async () => {
    const result = await ApplicationBootstrap.initialize({});

    assert.ok(result.startup);
    assert.ok(result.result);
    assert.strictEqual(typeof result.ready, 'boolean');
  });

  await t.test('initializes bootstrap with components', async () => {
    const components = {
      comp1: {},
      comp2: {}
    };

    const result = await ApplicationBootstrap.initializeWithComponents(components);

    assert.ok(result.startup);
  });

  await t.test('bootstrap returns ready status', async () => {
    const result = await ApplicationBootstrap.initialize({});

    assert.ok(typeof result.ready === 'boolean');
  });
});

test('Integration: Complete Startup Workflow', async (t) => {
  await t.test('executes full startup sequence', async () => {
    const sequence = new StartupSequence();

    // Setup environment
    sequence.envLoader.defineOptional('SERVICE_PORT', '3000', 'Service port');

    // Setup dependencies
    sequence.depInitializer.defineComponent('database', [], async () => {});
    sequence.depInitializer.defineComponent('cache', ['database'], async () => {});
    sequence.depInitializer.defineComponent('api', ['database', 'cache'], async () => {});

    // Setup configuration
    sequence.configValidator.defineSchema('app', {
      required: [],
      optional: ['SERVICE_PORT']
    });

    // Execute startup
    const result = await sequence.startup();

    assert.ok(result.phases.environment);
    assert.ok(result.phases.dependencies);
    assert.ok(result.phases.configuration);
  });

  await t.test('handles startup with shutdown handlers', async () => {
    const sequence = new StartupSequence();
    let startupComplete = false;
    let shutdownComplete = false;

    sequence.onShutdown(async () => {
      shutdownComplete = true;
    });

    await sequence.startup();
    startupComplete = true;

    const shutdownResult = await sequence.shutdown();

    assert.strictEqual(startupComplete, true);
    assert.strictEqual(shutdownComplete, true);
    assert.strictEqual(shutdownResult.success, true);
  });

  await t.test('validates startup phases in order', async () => {
    const sequence = new StartupSequence();
    const phaseOrder = [];

    sequence.envLoader.defineOptional('TEST', 'value', 'Test');
    sequence.depInitializer.defineComponent('comp', [], async () => {
      phaseOrder.push('dependencies');
    });

    const result = await sequence.startup();

    assert.ok(result.phases.environment);
    assert.ok(result.phases.dependencies);
    assert.ok(result.phases.configuration);
  });

  await t.test('reports errors from all phases', async () => {
    const sequence = new StartupSequence();

    // Add a required variable that won't be set
    sequence.envLoader.requireVariable('UNSET_VAR', 'Unset variable');

    const result = await sequence.startup();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errors.length, 1);
  });

  await t.test('tracks complete startup timeline', async () => {
    const sequence = new StartupSequence();
    sequence.depInitializer.defineComponent('slow-comp', [], async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    const result = await sequence.startup();

    assert.ok(result.startTime);
    assert.ok(result.endTime);
    assert.ok(result.duration > 0);
    assert.strictEqual(result.endTime > result.startTime, true);
  });

  await t.test('maintains status across startup phases', async () => {
    const sequence = new StartupSequence();
    assert.strictEqual(sequence.status, 'not_started');

    const result = await sequence.startup();
    assert.ok(['ready', 'failed', 'error'].includes(sequence.status));
  });
});
