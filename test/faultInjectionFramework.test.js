const test = require('node:test');
const assert = require('node:assert');
const {
  Fault,
  FaultInjector,
  ChaosScenarioBuilder
} = require('../src/faultInjectionFramework');

test('Fault Injection Framework', async (t) => {
  await t.test('Fault', async (t) => {
    await t.test('creates fault', () => {
      const fault = new Fault('f1', 'network', 'execute', null, { type: 'timeout' });

      assert.strictEqual(fault.id, 'f1');
      assert.strictEqual(fault.type, 'network');
      assert.strictEqual(fault.enabled, true);
    });

    await t.test('checks if should trigger with probability', () => {
      const fault = new Fault('f1', 'network', 'execute', null, { type: 'timeout' }, 0.0);

      assert.strictEqual(fault.shouldTrigger(), false);
    });

    await t.test('records hits', () => {
      const fault = new Fault('f1', 'network', 'execute', null, { type: 'timeout' });

      fault.recordHit();
      fault.recordHit();

      assert.strictEqual(fault.hitCount, 2);
    });

    await t.test('respects enabled flag', () => {
      const fault = new Fault('f1', 'network', 'execute', null, { type: 'timeout' });
      fault.enabled = false;

      assert.strictEqual(fault.shouldTrigger(), false);
    });

    await t.test('gets info', () => {
      const fault = new Fault('f1', 'network', 'execute', null, { type: 'timeout' });
      fault.recordHit();

      const info = fault.getInfo();
      assert.strictEqual(info.id, 'f1');
      assert.strictEqual(info.type, 'network');
      assert.strictEqual(info.hitCount, 1);
    });
  });

  await t.test('FaultInjector', async (t) => {
    await t.test('registers faults', () => {
      const injector = new FaultInjector();

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' });

      assert.ok(injector.getFault('f1'));
    });

    await t.test('toggles faults', () => {
      const injector = new FaultInjector({ scenarioMode: true });

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' });
      injector.setFaultEnabled('f1', false);

      assert.strictEqual(injector.getFault('f1').enabled, false);
    });

    await t.test('sets fault probability', () => {
      const injector = new FaultInjector();

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' });
      injector.setFaultProbability('f1', 0.5);

      assert.strictEqual(injector.getFault('f1').probability, 0.5);
    });

    await t.test('checks for applicable faults', () => {
      const injector = new FaultInjector({ scenarioMode: true });

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' }, 1.0);

      const fault = injector.checkFault('execute');
      assert.ok(fault);
      assert.strictEqual(fault.id, 'f1');
    });

    await t.test('does not return fault in non-scenario mode', () => {
      const injector = new FaultInjector({ scenarioMode: false });

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' }, 1.0);

      const fault = injector.checkFault('execute');
      assert.strictEqual(fault, null);
    });

    await t.test('respects trigger conditions', () => {
      const injector = new FaultInjector({ scenarioMode: true });

      let shouldTrigger = false;
      injector.registerFault('f1', 'network', 'execute', () => shouldTrigger, { type: 'timeout' }, 1.0);

      let fault = injector.checkFault('execute');
      assert.strictEqual(fault, null);

      shouldTrigger = true;
      fault = injector.checkFault('execute');
      assert.ok(fault);
    });

    await t.test('applies timeout fault', async () => {
      const injector = new FaultInjector({ scenarioMode: true });
      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout', message: 'Timed out' }, 1.0);

      const fault = injector.checkFault('execute');
      const effect = injector.applyFault(fault);

      assert.strictEqual(effect.throw.message, 'Timeout: Timed out');
    });

    await t.test('applies latency fault', async () => {
      const injector = new FaultInjector({ scenarioMode: true });
      injector.registerFault('f1', 'network', 'execute', null, { type: 'latency', delayMs: 100 }, 1.0);

      const fault = injector.checkFault('execute');
      const effect = injector.applyFault(fault);

      assert.strictEqual(effect.delay, 100);
    });

    await t.test('applies error fault', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      injector.registerFault('f1', 'service', 'verify', null, { type: 'error', statusCode: 500 }, 1.0);

      const fault = injector.checkFault('verify');
      const effect = injector.applyFault(fault);

      assert.strictEqual(effect.statusCode, 500);
    });

    await t.test('applies corruption fault', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      injector.registerFault('f1', 'data', 'execute', null, { type: 'corruption', corruptedData: {} }, 1.0);

      const fault = injector.checkFault('execute');
      const effect = injector.applyFault(fault);

      assert.strictEqual(effect.corrupted, true);
    });

    await t.test('applies partial response fault', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      injector.registerFault('f1', 'service', 'execute', null, { type: 'partial_response', partialData: { id: 1 } }, 1.0);

      const fault = injector.checkFault('execute');
      const effect = injector.applyFault(fault);

      assert.strictEqual(effect.partial, true);
      assert.strictEqual(effect.data.id, 1);
    });

    await t.test('records fault hits', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' }, 1.0);

      injector.checkFault('execute');
      injector.checkFault('execute');

      assert.strictEqual(injector.getFault('f1').hitCount, 2);
    });

    await t.test('gets statistics', () => {
      const injector = new FaultInjector({ scenarioMode: true });

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' }, 1.0);
      injector.registerFault('f2', 'service', 'verify', null, { type: 'error' }, 1.0);

      injector.checkFault('execute');

      const stats = injector.getStatistics();
      assert.strictEqual(stats.totalFaults, 2);
      assert.strictEqual(stats.enabledFaults, 2);
      assert.strictEqual(stats.totalHits, 1);
    });

    await t.test('resets individual fault', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' }, 1.0);

      injector.checkFault('execute');
      injector.resetFault('f1');

      assert.strictEqual(injector.getFault('f1').hitCount, 0);
    });

    await t.test('resets all faults', () => {
      const injector = new FaultInjector({ scenarioMode: true });

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' }, 1.0);
      injector.registerFault('f2', 'service', 'verify', null, { type: 'error' }, 1.0);

      injector.checkFault('execute');
      injector.checkFault('verify');
      injector.resetAll();

      assert.strictEqual(injector.getFault('f1').hitCount, 0);
      assert.strictEqual(injector.getFault('f2').hitCount, 0);
    });

    await t.test('gets logs', () => {
      const injector = new FaultInjector({ scenarioMode: true, logEnabled: true });

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' }, 1.0);
      injector.checkFault('execute');

      const logs = injector.getLogs({ event: 'fault_triggered' });
      assert.ok(logs.length > 0);
    });

    await t.test('clears all data', () => {
      const injector = new FaultInjector({ scenarioMode: true });

      injector.registerFault('f1', 'network', 'execute', null, { type: 'timeout' }, 1.0);

      injector.clearAll();

      assert.strictEqual(injector.faults.size, 0);
      assert.strictEqual(injector.logs.length, 0);
    });
  });

  await t.test('ChaosScenarioBuilder', async (t) => {
    await t.test('builds network partition scenario', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      const builder = new ChaosScenarioBuilder(injector);

      const scenario = builder.networkPartition();

      assert.ok(scenario);
      assert.strictEqual(scenario.faults.length, 2);
    });

    await t.test('builds cascading failure scenario', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      const builder = new ChaosScenarioBuilder(injector);

      const scenario = builder.cascadingFailure();

      assert.ok(scenario);
      assert.strictEqual(scenario.faults.length, 3);
    });

    await t.test('builds race condition scenario', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      const builder = new ChaosScenarioBuilder(injector);

      const scenario = builder.raceCondition();

      assert.ok(scenario);
      assert.strictEqual(scenario.faults.length, 1);
    });

    await t.test('builds resource exhaustion scenario', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      const builder = new ChaosScenarioBuilder(injector);

      const scenario = builder.resourceExhaustion();

      assert.ok(scenario);
      assert.strictEqual(scenario.faults.length, 1);
    });

    await t.test('enables/disables scenarios', () => {
      const injector = new FaultInjector({ scenarioMode: true });
      const builder = new ChaosScenarioBuilder(injector);

      const scenario = builder.networkPartition();

      // Set probability to 1.0 to make test deterministic
      injector.setFaultProbability('network_partition_timeout', 1.0);
      injector.setFaultProbability('network_partition_latency', 1.0);

      scenario.disable();

      const fault = injector.checkFault('execute');
      assert.strictEqual(fault, null);

      scenario.enable();
      const fault2 = injector.checkFault('execute');
      assert.ok(fault2);
    });
  });
});
