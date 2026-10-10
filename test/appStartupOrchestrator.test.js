/**
 * Tests for Application Startup Orchestrator
 * Covers phase management, validation, recovery, and orchestration
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  StartupSequenceManager,
  StartupValidator,
  StartupRecovery,
  InitializationOrchestrator
} = require('../src/appStartupOrchestrator');

test('StartupSequenceManager', async (t) => {
  await t.test('initializes with correct phases', () => {
    const manager = new StartupSequenceManager();
    assert.deepStrictEqual(manager.phases, ['init', 'validate', 'load', 'ready']);
    assert.strictEqual(manager.currentPhase, null);
    assert.strictEqual(manager.completedPhases.length, 0);
  });

  await t.test('starts phase in correct order', () => {
    const manager = new StartupSequenceManager();
    const result = manager.startPhase('init');
    assert.strictEqual(result.phase, 'init');
    assert.ok(result.startTime);
    assert.strictEqual(manager.currentPhase, 'init');
  });

  await t.test('throws on invalid phase', () => {
    const manager = new StartupSequenceManager();
    assert.throws(() => manager.startPhase('invalid'), /Invalid phase/);
  });

  await t.test('enforces sequential phase transitions', () => {
    const manager = new StartupSequenceManager();
    manager.startPhase('init');
    manager.completePhase({ status: 'initialized' });

    assert.throws(() => manager.startPhase('load'), /phases must be sequential/);
  });

  await t.test('completes phase successfully', () => {
    const manager = new StartupSequenceManager();
    manager.startPhase('init');
    const result = manager.completePhase({ status: 'initialized' });

    assert.strictEqual(result.phase, 'init');
    assert.ok(result.duration >= 0);
    assert.deepStrictEqual(result.result, { status: 'initialized' });
    assert.ok(manager.completedPhases.includes('init'));
  });

  await t.test('prevents phase completion without active phase', () => {
    const manager = new StartupSequenceManager();
    assert.throws(() => manager.completePhase({}), /No phase currently executing/);
  });

  await t.test('records phase errors', () => {
    const manager = new StartupSequenceManager();
    const error = new Error('Test error');
    manager.recordPhaseError('init', error);

    assert.ok(manager.phaseErrors['init']);
    assert.strictEqual(manager.phaseErrors['init'][0].message, 'Test error');
  });

  await t.test('getStatus returns complete status', () => {
    const manager = new StartupSequenceManager();
    manager.startPhase('init');
    manager.completePhase({});

    const status = manager.getStatus();
    assert.deepStrictEqual(status.completedPhases, ['init']);
    assert.strictEqual(status.currentPhase, null);
    assert.strictEqual(status.isReady, false);
  });

  await t.test('isStartupComplete returns true when all phases done', () => {
    const manager = new StartupSequenceManager();
    for (const phase of manager.phases) {
      manager.startPhase(phase);
      manager.completePhase({});
    }
    assert.strictEqual(manager.isStartupComplete(), true);
  });

  await t.test('getTimingStats returns all phase timings', () => {
    const manager = new StartupSequenceManager();
    manager.startPhase('init');
    manager.completePhase({});
    manager.startPhase('validate');
    manager.completePhase({});

    const stats = manager.getTimingStats();
    assert.ok(stats.init);
    assert.ok(stats.validate);
    assert.ok(stats.init.duration >= 0);
  });
});

test('StartupValidator', async (t) => {
  await t.test('defines prerequisites for phase', () => {
    const validator = new StartupValidator();
    validator.definePrerequisites('init', { configExists: true });
    assert.ok(validator.prerequisites['init']);
  });

  await t.test('throws on invalid prerequisites object', () => {
    const validator = new StartupValidator();
    assert.throws(() => validator.definePrerequisites('init', null), /Conditions must be an object/);
  });

  await t.test('validates phase prerequisites with all checks passing', () => {
    const validator = new StartupValidator();
    validator.definePrerequisites('init', {
      checkA: true,
      checkB: () => true
    });

    const result = validator.validatePhasePrerequisites('init', {});
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.failureReasons.length, 0);
    assert.strictEqual(result.checks.length, 2);
  });

  await t.test('fails validation when check fails', () => {
    const validator = new StartupValidator();
    validator.definePrerequisites('init', {
      checkA: false,
      checkB: () => true
    });

    const result = validator.validatePhasePrerequisites('init', {});
    assert.strictEqual(result.valid, false);
    assert.ok(result.failureReasons[0].includes('checkA'));
  });

  await t.test('validates with function checks', () => {
    const validator = new StartupValidator();
    validator.definePrerequisites('init', {
      contextCheck: (context) => context.initialized === true
    });

    const result = validator.validatePhasePrerequisites('init', { initialized: true });
    assert.strictEqual(result.valid, true);
  });

  await t.test('handles check errors gracefully', () => {
    const validator = new StartupValidator();
    validator.definePrerequisites('init', {
      errorCheck: () => { throw new Error('Check failed'); }
    });

    const result = validator.validatePhasePrerequisites('init', {});
    assert.strictEqual(result.valid, false);
    assert.ok(result.failureReasons[0].includes('Check error'));
  });

  await t.test('returns true when phase has no prerequisites', () => {
    const validator = new StartupValidator();
    const result = validator.validatePhasePrerequisites('unknown', {});
    assert.strictEqual(result.valid, true);
  });

  await t.test('maintains validation history', () => {
    const validator = new StartupValidator();
    validator.definePrerequisites('init', { check: true });

    validator.validatePhasePrerequisites('init', {});
    validator.validatePhasePrerequisites('init', {});

    const history = validator.getHistory();
    assert.strictEqual(history.length, 2);
  });

  await t.test('prunes validation history to keep recent entries', () => {
    const validator = new StartupValidator();
    validator.definePrerequisites('init', { check: true });

    for (let i = 0; i < 150; i++) {
      validator.validatePhasePrerequisites('init', {});
    }

    validator.pruneHistory(100);
    assert.strictEqual(validator.getHistory().length, 100);
  });
});

test('StartupRecovery', async (t) => {
  await t.test('defines recovery strategy', () => {
    const recovery = new StartupRecovery();
    recovery.defineRecoveryStrategy('init_failure', {
      condition: true,
      actions: []
    });
    assert.ok(recovery.recoveryStrategies['init_failure']);
  });

  await t.test('throws on invalid strategy', () => {
    const recovery = new StartupRecovery();
    assert.throws(() => recovery.defineRecoveryStrategy('fail', null), /Strategy must be an object/);
    assert.throws(() => recovery.defineRecoveryStrategy('fail', {}), /must have condition/);
  });

  await t.test('returns result when no strategy exists', async () => {
    const recovery = new StartupRecovery();
    const result = await recovery.attemptRecovery('unknown_failure', {});

    assert.strictEqual(result.recovered, false);
    assert.ok(result.reason.includes('No recovery strategy'));
  });

  await t.test('skips recovery when condition not met', async () => {
    const recovery = new StartupRecovery();
    recovery.defineRecoveryStrategy('test_failure', {
      condition: false,
      actions: []
    });

    const result = await recovery.attemptRecovery('test_failure', {});
    assert.strictEqual(result.recovered, false);
    assert.ok(result.reason.includes('condition not met'));
  });

  await t.test('executes recovery actions', async () => {
    const recovery = new StartupRecovery();
    let actionExecuted = false;

    recovery.defineRecoveryStrategy('test_failure', {
      condition: true,
      actions: [
        async () => { actionExecuted = true; }
      ]
    });

    const result = await recovery.attemptRecovery('test_failure', {});
    assert.strictEqual(result.recovered, true);
    assert.strictEqual(actionExecuted, true);
    assert.strictEqual(result.actions[0].success, true);
  });

  await t.test('handles action errors in recovery', async () => {
    const recovery = new StartupRecovery();
    recovery.defineRecoveryStrategy('test_failure', {
      condition: true,
      actions: [
        async () => { throw new Error('Action failed'); }
      ]
    });

    const result = await recovery.attemptRecovery('test_failure', {});
    assert.strictEqual(result.recovered, false);
    assert.strictEqual(result.actions[0].success, false);
  });

  await t.test('maintains recovery history', async () => {
    const recovery = new StartupRecovery();
    recovery.defineRecoveryStrategy('test_failure', {
      condition: true,
      actions: []
    });

    await recovery.attemptRecovery('test_failure', {});
    const history = recovery.getHistory();
    assert.strictEqual(history.length, 1);
  });

  await t.test('wasLastRecoverySuccessful reports last result', async () => {
    const recovery = new StartupRecovery();
    recovery.defineRecoveryStrategy('test_failure', {
      condition: true,
      actions: []
    });

    await recovery.attemptRecovery('test_failure', {});
    assert.strictEqual(recovery.wasLastRecoverySuccessful(), true);
  });
});

test('InitializationOrchestrator', async (t) => {
  await t.test('initializes with managers', () => {
    const orchestrator = new InitializationOrchestrator();
    assert.ok(orchestrator.sequenceManager);
    assert.ok(orchestrator.validator);
    assert.ok(orchestrator.recovery);
  });

  await t.test('throws on empty phases array', async () => {
    const orchestrator = new InitializationOrchestrator();
    assert.rejects(() => orchestrator.executeStartup([]), /non-empty array/);
  });

  await t.test('executes simple startup with no validation', async () => {
    const orchestrator = new InitializationOrchestrator();
    const phases = [
      {
        name: 'init',
        execute: async () => ({ initialized: true })
      }
    ];

    const result = await orchestrator.executeStartup(phases);
    assert.strictEqual(result.success, false); // Only 1 of 4 phases, not complete
    assert.strictEqual(result.phases.length, 1);
    assert.strictEqual(result.phases[0].success, true);
  });

  await t.test('executes all startup phases in order', async () => {
    const orchestrator = new InitializationOrchestrator();
    const phases = [
      { name: 'init', execute: async () => ({ step: 1 }) },
      { name: 'validate', execute: async () => ({ step: 2 }) },
      { name: 'load', execute: async () => ({ step: 3 }) },
      { name: 'ready', execute: async () => ({ step: 4 }) }
    ];

    const result = await orchestrator.executeStartup(phases);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.phases.length, 4);
  });

  await t.test('validates prerequisites before execution', async () => {
    const orchestrator = new InitializationOrchestrator();

    orchestrator.validator.definePrerequisites('init', {
      ready: () => true
    });

    const phases = [
      { name: 'init', validate: true, execute: async () => ({}) }
    ];

    const result = await orchestrator.executeStartup(phases);
    assert.ok(result.phases[0].success);
  });

  await t.test('attempts recovery on validation failure', async () => {
    const orchestrator = new InitializationOrchestrator();

    orchestrator.validator.definePrerequisites('init', {
      checkFails: false
    });

    orchestrator.recovery.defineRecoveryStrategy('init_validation_failure', {
      condition: true,
      actions: [async () => {}]
    });

    const phases = [
      { name: 'init', validate: true, execute: async () => ({}) }
    ];

    const result = await orchestrator.executeStartup(phases);
    assert.ok(result.phases[0].success);
  });

  await t.test('fails startup when recovery unsuccessful', async () => {
    const orchestrator = new InitializationOrchestrator();

    orchestrator.validator.definePrerequisites('init', {
      checkFails: false
    });

    // No recovery strategy defined - recovery will fail

    const phases = [
      { name: 'init', validate: true, execute: async () => ({}) }
    ];

    const result = await orchestrator.executeStartup(phases);
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length > 0);
  });

  await t.test('updates execution context through phases', async () => {
    const orchestrator = new InitializationOrchestrator();
    const phases = [
      { name: 'init', execute: async () => ({ config: 'loaded' }) },
      { name: 'validate', execute: async (ctx) => {
        assert.strictEqual(ctx.config, 'loaded');
        return { validated: true };
      } }
    ];

    await orchestrator.executeStartup(phases);
    assert.strictEqual(orchestrator.executionContext.config, 'loaded');
    assert.strictEqual(orchestrator.executionContext.validated, true);
  });

  await t.test('generates startup ID', async () => {
    const orchestrator = new InitializationOrchestrator();
    const phases = [
      { name: 'init', execute: async () => ({}) }
    ];

    await orchestrator.executeStartup(phases);
    assert.ok(orchestrator.startupId);
    assert.strictEqual(orchestrator.startupId.length, 16); // 8 bytes hex
  });

  await t.test('getStartupState returns complete state', async () => {
    const orchestrator = new InitializationOrchestrator();
    const phases = [
      { name: 'init', execute: async () => ({}) }
    ];

    await orchestrator.executeStartup(phases);
    const state = orchestrator.getStartupState();

    assert.ok(state.startupId);
    assert.ok(state.sequenceStatus);
    assert.ok(state.timingStats);
    assert.ok(Array.isArray(state.validationHistory));
    assert.ok(Array.isArray(state.recoveryHistory));
  });

  await t.test('reset clears startup state', async () => {
    const orchestrator = new InitializationOrchestrator();
    const phases = [
      { name: 'init', execute: async () => ({}) }
    ];

    await orchestrator.executeStartup(phases);
    assert.ok(orchestrator.startupId);

    orchestrator.reset();
    assert.strictEqual(orchestrator.startupId, null);
    assert.strictEqual(orchestrator.executionContext.config, undefined);
  });

  await t.test('isReady reports startup completion', async () => {
    const orchestrator = new InitializationOrchestrator();
    const phases = [
      { name: 'init', execute: async () => ({}) },
      { name: 'validate', execute: async () => ({}) },
      { name: 'load', execute: async () => ({}) },
      { name: 'ready', execute: async () => ({}) }
    ];

    await orchestrator.executeStartup(phases);
    assert.strictEqual(orchestrator.isReady(), true);
  });

  await t.test('integration: complete startup workflow with validation and recovery', async () => {
    const orchestrator = new InitializationOrchestrator();

    // Define validation for init phase
    orchestrator.validator.definePrerequisites('init', {
      configReady: (ctx) => ctx.configFile === true
    });

    // Define recovery if validation fails
    orchestrator.recovery.defineRecoveryStrategy('init_validation_failure', {
      condition: true,
      actions: [
        async (ctx) => { ctx.configFile = true; }
      ]
    });

    // Define recovery for execution failure
    orchestrator.recovery.defineRecoveryStrategy('validate_execution_failure', {
      condition: true,
      actions: [
        async (ctx) => { ctx.validated = true; }
      ]
    });

    const phases = [
      {
        name: 'init',
        validate: true,
        execute: async (ctx) => ({
          initialized: true,
          config: 'default'
        })
      },
      {
        name: 'validate',
        validate: false,
        execute: async (ctx) => ({
          validated: true
        })
      },
      {
        name: 'load',
        execute: async (ctx) => ({
          loaded: true
        })
      },
      {
        name: 'ready',
        execute: async (ctx) => ({
          ready: true
        })
      }
    ];

    const result = await orchestrator.executeStartup(phases);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.phases.length, 4);
    assert.ok(result.totalDuration >= 0);
    assert.strictEqual(orchestrator.isReady(), true);
  });
});
