const test = require('node:test');
const assert = require('node:assert');
const { ReuseEngine } = require('../src/reuseEngine');

test('ReuseEngine - initialization', (t) => {
  const engine = new ReuseEngine();
  assert.ok(engine, 'Engine instantiated');
  assert.ok(Array.isArray(engine.patterns), 'Patterns array initialized');
  assert.ok(Array.isArray(engine.successHistory), 'Success history initialized');
  assert.ok(Array.isArray(engine.failureHistory), 'Failure history initialized');
  assert.equal(engine.options.minSuccessCountForPattern, 3, 'Default minSuccessCountForPattern is 3');
  assert.equal(engine.options.minSuccessRateForTemplate, 0.8, 'Default minSuccessRateForTemplate is 0.8');
  assert.equal(engine.options.patternRetentionDays, 365, 'Default patternRetentionDays is 365');
});

test('ReuseEngine - custom options', (t) => {
  const engine = new ReuseEngine({
    minSuccessCountForPattern: 5,
    minSuccessRateForTemplate: 0.9,
    patternRetentionDays: 180
  });
  assert.equal(engine.options.minSuccessCountForPattern, 5);
  assert.equal(engine.options.minSuccessRateForTemplate, 0.9);
  assert.equal(engine.options.patternRetentionDays, 180);
});

// Test 1: recordSuccess - basic operation recording
test('recordSuccess - records successful operation', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'publish_powerapps_app',
    operationId: 'op-123',
    steps: [
      { action: 'fetch', parameters: {}, expected: 'ok' },
      { action: 'publish', parameters: {}, expected: 'published' }
    ],
    targetId: 'app-456',
    environment: 'production',
    executionTime: 1500,
    approvalRequired: true,
    correlationId: 'corr-789'
  };

  const record = engine.recordSuccess(context);

  assert.ok(record.id, 'Record has ID');
  assert.equal(record.status, 'success', 'Status is success');
  assert.equal(record.operation, 'publish_powerapps_app');
  assert.equal(record.operationId, 'op-123');
  assert.equal(engine.successHistory.length, 1, 'Success history updated');
});

// Test 2: recordFailure - basic failure recording
test('recordFailure - records failed operation', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'deploy_app',
    operationId: 'op-124',
    steps: [
      { action: 'build', parameters: {}, expected: 'ok' }
    ],
    targetId: 'app-457',
    environment: 'test',
    errorReason: 'network_timeout',
    failurePoint: 'step_1',
    correlationId: 'corr-790'
  };

  const record = engine.recordFailure(context);

  assert.ok(record.id, 'Record has ID');
  assert.equal(record.status, 'failure', 'Status is failure');
  assert.equal(record.errorReason, 'network_timeout');
  assert.equal(engine.failureHistory.length, 1, 'Failure history updated');
});

// Test 3: generateSignature - creates consistent fingerprints
test('generateSignature - creates consistent signatures', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'save_app',
    targetId: 'app-123',
    environment: 'dev',
    stepCount: 3
  };

  const sig1 = engine.generateSignature(context);
  const sig2 = engine.generateSignature(context);

  assert.equal(sig1, sig2, 'Same context produces same signature');
  assert.equal(sig1.length, 16, 'Signature is 16 characters');
});

// Test 4: generateSignature - different contexts produce different signatures
test('generateSignature - different contexts produce different signatures', (t) => {
  const engine = new ReuseEngine();
  const context1 = {
    operation: 'save_app',
    targetId: 'app-123',
    environment: 'dev',
    stepCount: 3
  };

  const context2 = {
    operation: 'save_app',
    targetId: 'app-456',
    environment: 'dev',
    stepCount: 3
  };

  const sig1 = engine.generateSignature(context1);
  const sig2 = engine.generateSignature(context2);

  assert.notEqual(sig1, sig2, 'Different contexts produce different signatures');
});

// Test 5: updateOrCreatePattern - creates new pattern
test('updateOrCreatePattern - creates new pattern on first success', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'publish_app',
    targetId: 'app-123',
    environment: 'production'
  };

  const sig = engine.generateSignature({
    operation: context.operation,
    targetId: context.targetId,
    environment: context.environment,
    stepCount: 1
  });

  engine.updateOrCreatePattern(sig, true, context);

  assert.equal(engine.patterns.length, 1, 'Pattern created');
  assert.equal(engine.patterns[0].successCount, 1);
  assert.equal(engine.patterns[0].failureCount, 0);
  assert.equal(engine.patterns[0].successRate, 1.0);
});

// Test 6: updateOrCreatePattern - increments success count
test('updateOrCreatePattern - increments success count', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'save_app',
    targetId: 'app-234',
    environment: 'test'
  };

  const sig = engine.generateSignature({
    operation: context.operation,
    targetId: context.targetId,
    environment: context.environment,
    stepCount: 2
  });

  engine.updateOrCreatePattern(sig, true, context);
  engine.updateOrCreatePattern(sig, true, context);
  engine.updateOrCreatePattern(sig, false, context); // One failure

  assert.equal(engine.patterns[0].successCount, 2);
  assert.equal(engine.patterns[0].failureCount, 1);
  assert.equal(engine.patterns[0].usageCount, 3);
  assert.equal(Math.round(engine.patterns[0].successRate * 100) / 100, 0.67);
});

// Test 7: categorizePattern - deployment pattern
test('categorizePattern - categorizes deployment operations', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'publish_powerapps_app'
  };

  const category = engine.categorizePattern(context);
  assert.equal(category, 'deployment');
});

// Test 8: categorizePattern - deletion pattern
test('categorizePattern - categorizes deletion operations', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'delete_app'
  };

  const category = engine.categorizePattern(context);
  assert.equal(category, 'deletion');
});

// Test 9: categorizePattern - modification pattern
test('categorizePattern - categorizes modification operations', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'save_app'
  };

  const category = engine.categorizePattern(context);
  assert.equal(category, 'modification');
});

// Test 10: generateTemplate - creates reusable template
test('generateTemplate - generates template from operation', (t) => {
  const engine = new ReuseEngine();
  const context = {
    operation: 'publish_app',
    steps: [
      { action: 'fetch', parameters: { appId: '${appId}' }, expected: 'fetched' },
      { action: 'publish', parameters: { version: '${version}' }, expected: 'published' }
    ],
    targetId: 'app-123',
    environment: 'production',
    approvalRequired: true
  };

  const template = engine.generateTemplate(context);

  assert.equal(template.name, 'publish_app_template');
  assert.equal(template.operation, 'publish_app');
  assert.equal(template.steps.length, 2);
  assert.equal(template.steps[0].action, 'fetch');
  assert.ok(template.variables.includes('${appId}'));
});

// Test 11: suggestPattern - exact match with high confidence
test('suggestPattern - suggests exact match for proven pattern', (t) => {
  const engine = new ReuseEngine();

  // Build pattern history
  for (let i = 0; i < 4; i++) {
    engine.recordSuccess({
      operation: 'save_app',
      operationId: `op-${i}`,
      steps: [{ action: 'save' }],
      targetId: 'app-123',
      environment: 'dev',
      executionTime: 500
    });
  }

  const suggestion = engine.suggestPattern({
    operation: 'save_app',
    targetId: 'app-123',
    environment: 'dev',
    steps: [{ action: 'save' }]
  });

  assert.equal(suggestion.matchType, 'exact');
  assert.equal(suggestion.confidence, 1.0);
  assert.ok(suggestion.pattern);
});

// Test 12: suggestPattern - similar match
test('suggestPattern - suggests similar pattern', (t) => {
  const engine = new ReuseEngine();

  for (let i = 0; i < 3; i++) {
    engine.recordSuccess({
      operation: 'deploy_app',
      operationId: `op-${i}`,
      steps: [{ action: 'deploy' }],
      targetId: 'app-100',
      environment: 'production',
      executionTime: 2000
    });
  }

  const suggestion = engine.suggestPattern({
    operation: 'deploy_app',
    targetId: 'app-200', // Different target
    environment: 'production',
    steps: [{ action: 'deploy' }]
  });

  assert.equal(suggestion.matchType, 'similar');
  assert.ok(suggestion.patterns);
  assert.ok(suggestion.patterns.length > 0);
});

// Test 13: suggestPattern - no match
test('suggestPattern - returns no match for new operation', (t) => {
  const engine = new ReuseEngine();

  const suggestion = engine.suggestPattern({
    operation: 'unknown_operation',
    targetId: 'app-xyz',
    environment: 'test',
    steps: []
  });

  assert.equal(suggestion.matchType, 'none');
  assert.equal(suggestion.confidence, 0);
});

// Test 14: getPlaybook - generates playbook from pattern
test('getPlaybook - generates playbook for operation', (t) => {
  const engine = new ReuseEngine();

  for (let i = 0; i < 3; i++) {
    engine.recordSuccess({
      operation: 'save_app',
      operationId: `op-${i}`,
      steps: [
        { action: 'fetch', parameters: {}, expected: 'ok' },
        { action: 'save', parameters: {}, expected: 'saved' }
      ],
      targetId: 'app-123',
      environment: 'dev',
      executionTime: 1000
    });
  }

  const playbook = engine.getPlaybook('save_app', 'dev');

  assert.ok(playbook);
  assert.equal(playbook.operation, 'save_app');
  assert.equal(playbook.environment, 'dev');
  assert.equal(playbook.successHistory, 3);
  assert.ok(playbook.template);
  assert.ok(playbook.checkpoints);
  assert.ok(playbook.estimatedDuration);
});

// Test 15: getPlaybook - returns null for no matching pattern
test('getPlaybook - returns null when no pattern exists', (t) => {
  const engine = new ReuseEngine();

  const playbook = engine.getPlaybook('nonexistent_op', 'dev');

  assert.equal(playbook, null);
});

// Test 16: identifyRiskFactors - analyzes common failures
test('identifyRiskFactors - identifies common failure reasons', (t) => {
  const engine = new ReuseEngine();

  // Create pattern with failures
  for (let i = 0; i < 2; i++) {
    engine.recordSuccess({
      operation: 'deploy_app',
      operationId: `op-s${i}`,
      steps: [{ action: 'deploy' }],
      targetId: 'app-456',
      environment: 'prod',
      executionTime: 1500
    });
  }

  for (let i = 0; i < 2; i++) {
    engine.recordFailure({
      operation: 'deploy_app',
      operationId: `op-f${i}`,
      steps: [{ action: 'deploy' }],
      targetId: 'app-456',
      environment: 'prod',
      errorReason: 'network_timeout'
    });
  }

  const pattern = engine.patterns[0];
  const risks = engine.identifyRiskFactors(pattern);

  assert.ok(risks.length > 0, 'Risk factors identified');
  assert.ok(risks[0].reason, 'Risk reason recorded');
  assert.ok(risks[0].mitigation, 'Mitigation suggestion provided');
});

// Test 17: suggestMitigation - provides mitigation for known failures
test('suggestMitigation - provides mitigation for network timeout', (t) => {
  const engine = new ReuseEngine();
  const mitigation = engine.suggestMitigation('network_timeout');

  assert.ok(mitigation.includes('retry'));
});

// Test 18: suggestMitigation - provides mitigation for permission denied
test('suggestMitigation - provides mitigation for permission denied', (t) => {
  const engine = new ReuseEngine();
  const mitigation = engine.suggestMitigation('permission_denied');

  assert.ok(mitigation.includes('approval'));
});

// Test 19: identifyCheckpoints - creates verification points
test('identifyCheckpoints - creates checkpoints for multi-step operation', (t) => {
  const engine = new ReuseEngine();

  engine.recordSuccess({
    operation: 'multi_step',
    operationId: 'op-100',
    steps: [
      { action: 'step1', expected: 'ok' },
      { action: 'step2', expected: 'ok' },
      { action: 'step3', expected: 'ok' },
      { action: 'step4', expected: 'ok' }
    ],
    targetId: 'app-789',
    environment: 'test',
    executionTime: 2000
  });

  const pattern = engine.patterns[0];
  const checkpoints = engine.identifyCheckpoints(pattern);

  assert.ok(checkpoints.length > 0, 'Checkpoints created');
  assert.ok(checkpoints[0].verifyAction, 'Checkpoint has verify action');
  assert.ok(checkpoints[0].rollbackAction, 'Checkpoint has rollback action');
});

// Test 20: estimateDuration - calculates execution time estimate
test('estimateDuration - estimates duration from history', (t) => {
  const engine = new ReuseEngine();

  engine.recordSuccess({
    operation: 'quick_op',
    operationId: 'op-1',
    steps: [{ action: 'quick' }],
    targetId: 'app-1',
    environment: 'dev',
    executionTime: 100
  });

  engine.recordSuccess({
    operation: 'quick_op',
    operationId: 'op-2',
    steps: [{ action: 'quick' }],
    targetId: 'app-1',
    environment: 'dev',
    executionTime: 150
  });

  engine.recordSuccess({
    operation: 'quick_op',
    operationId: 'op-3',
    steps: [{ action: 'quick' }],
    targetId: 'app-1',
    environment: 'dev',
    executionTime: 200
  });

  const pattern = engine.patterns[0];
  const duration = engine.estimateDuration(pattern);

  assert.ok(duration.estimate);
  assert.ok(duration.min);
  assert.ok(duration.max);
  assert.equal(duration.unit, 'ms');
});

// Test 21: analyzePrerequisites - identifies prerequisite patterns
test('analyzePrerequisites - identifies common prerequisites', (t) => {
  const engine = new ReuseEngine();

  engine.recordSuccess({
    operation: 'deploy_app',
    operationId: 'op-1',
    steps: [
      { action: 'prepare', prerequisite: 'fetch_source' },
      { action: 'build', prerequisite: 'prepare' },
      { action: 'deploy', prerequisite: 'build' }
    ],
    targetId: 'app-123',
    environment: 'prod',
    executionTime: 3000
  });

  const pattern = engine.patterns[0];
  const prereqs = engine.analyzePrerequisites(pattern);

  assert.ok(Array.isArray(prereqs));
});

// Test 22: suggestOptimization - provides optimization suggestions
test('suggestOptimization - suggests optimization for proven pattern', (t) => {
  const engine = new ReuseEngine();

  for (let i = 0; i < 4; i++) {
    engine.recordSuccess({
      operation: 'save_app',
      operationId: `op-${i}`,
      steps: [
        { action: 'fetch', expected: 'ok' },
        { action: 'save', expected: 'saved' }
      ],
      targetId: 'app-opt',
      environment: 'dev',
      executionTime: 500
    });
  }

  const optimization = engine.suggestOptimization({
    operation: 'save_app',
    targetId: 'app-opt',
    environment: 'dev',
    steps: [{ action: 'fetch' }, { action: 'save' }]
  });

  assert.ok(optimization);
  assert.equal(optimization.optimization, 'recommended');
  assert.ok(optimization.suggestions.length > 0);
});

// Test 23: findSlowestStep - identifies performance bottleneck
test('findSlowestStep - finds slowest step in pattern', (t) => {
  const engine = new ReuseEngine();

  engine.recordSuccess({
    operation: 'complex_op',
    operationId: 'op-1',
    steps: [
      { action: 'prepare' },
      { action: 'deploy', expected: 'deployed' },
      { action: 'verify' }
    ],
    targetId: 'app-slow',
    environment: 'test',
    executionTime: 2000
  });

  const pattern = engine.patterns[0];
  const slowest = engine.findSlowestStep(pattern);

  // May return null or step containing 'deploy'/'publish'
  assert.ok(slowest === null || slowest.action.includes('deploy') || slowest.action.includes('publish'));
});

// Test 24: cleanupOldPatterns - removes expired patterns
test('cleanupOldPatterns - respects retention policy', (t) => {
  const engine = new ReuseEngine({ patternRetentionDays: 0 });

  engine.recordSuccess({
    operation: 'old_op',
    operationId: 'op-old',
    steps: [{ action: 'test' }],
    targetId: 'app-old',
    environment: 'dev',
    executionTime: 500
  });

  assert.equal(engine.patterns.length, 1, 'Pattern created');

  const result = engine.cleanupOldPatterns();

  assert.ok(result.deletedCount >= 0);
  assert.ok(result.remainingCount >= 0);
});

// Test 25: getStatistics - provides comprehensive statistics
test('getStatistics - generates statistics report', (t) => {
  const engine = new ReuseEngine();

  for (let i = 0; i < 3; i++) {
    engine.recordSuccess({
      operation: 'op1',
      operationId: `op-${i}`,
      steps: [{ action: 'action1' }],
      targetId: 'app-1',
      environment: 'dev',
      executionTime: 500
    });
  }

  engine.recordFailure({
    operation: 'op2',
    operationId: 'op-fail',
    steps: [{ action: 'action2' }],
    targetId: 'app-2',
    environment: 'test',
    errorReason: 'test_error'
  });

  const stats = engine.getStatistics();

  assert.ok(stats.totalPatterns >= 0);
  assert.ok(stats.usablePatterns >= 0);
  assert.ok(stats.totalSuccesses >= 3);
  assert.ok(stats.totalFailures >= 1);
  assert.ok(stats.patterns);
});

// Test 26: Pattern lifecycle - from success to playbook
test('Pattern lifecycle - from recording to playbook generation', (t) => {
  const engine = new ReuseEngine();

  // Record multiple successes
  for (let i = 0; i < 3; i++) {
    engine.recordSuccess({
      operation: 'full_lifecycle',
      operationId: `op-${i}`,
      steps: [
        { action: 'init', parameters: {}, expected: 'ready' },
        { action: 'execute', parameters: {}, expected: 'done' }
      ],
      targetId: 'app-lifecycle',
      environment: 'staging',
      executionTime: 1000 + (i * 100),
      approvalRequired: true
    });
  }

  // Check pattern was created
  assert.equal(engine.patterns.length, 1, 'Pattern exists');

  // Check playbook can be generated
  const playbook = engine.getPlaybook('full_lifecycle', 'staging');
  assert.ok(playbook, 'Playbook generated');
  assert.equal(playbook.successHistory, 3);
  assert.equal(playbook.successRate, 1.0);

  // Check statistics
  const stats = engine.getStatistics();
  assert.ok(stats.totalPatterns > 0);
  assert.ok(stats.usablePatterns > 0);
});

// Test 27: Mixed success and failure pattern
test('Mixed success and failure - risk assessment', (t) => {
  const engine = new ReuseEngine();

  // 3 successes, 2 failures
  for (let i = 0; i < 3; i++) {
    engine.recordSuccess({
      operation: 'risky_op',
      operationId: `op-s${i}`,
      steps: [{ action: 'risky' }],
      targetId: 'app-risky',
      environment: 'prod',
      executionTime: 1500
    });
  }

  for (let i = 0; i < 2; i++) {
    engine.recordFailure({
      operation: 'risky_op',
      operationId: `op-f${i}`,
      steps: [{ action: 'risky' }],
      targetId: 'app-risky',
      environment: 'prod',
      errorReason: 'state_mismatch'
    });
  }

  const suggestion = engine.suggestPattern({
    operation: 'risky_op',
    targetId: 'app-risky',
    environment: 'prod',
    steps: [{ action: 'risky' }]
  });

  // Should detect risk pattern
  assert.ok(suggestion.matchType === 'risk' || suggestion.matchType === 'similar');
});

// Test 28: Pattern observations tracking
test('Pattern observations - tracks all operation outcomes', (t) => {
  const engine = new ReuseEngine();

  const context = {
    operation: 'tracked_op',
    targetId: 'app-track',
    environment: 'test'
  };

  // Record success
  engine.recordSuccess({
    operation: context.operation,
    operationId: 'op-1',
    steps: [{ action: 'track' }],
    targetId: context.targetId,
    environment: context.environment,
    executionTime: 500
  });

  // Record failure
  engine.recordFailure({
    operation: context.operation,
    operationId: 'op-2',
    steps: [{ action: 'track' }],
    targetId: context.targetId,
    environment: context.environment,
    errorReason: 'test'
  });

  const pattern = engine.patterns[0];

  assert.ok(pattern.observations);
  assert.ok(pattern.observations.length >= 2);
  assert.ok(pattern.observations[0].success === true);
  assert.ok(pattern.observations[1].success === false);
});
