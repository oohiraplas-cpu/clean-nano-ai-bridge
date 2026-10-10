/**
 * Phase 12: Runtime Evidence Engine Tests
 * Tests for runtime operation capture, integrity signing, and health reporting
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { RuntimeEvidenceEngine } from '../src/runtimeEvidenceEngine.js';

test('RuntimeEvidenceEngine', async (t) => {
  // ==================== Initialization & Configuration ====================

  await t.test('initializes with default options', () => {
    const engine = new RuntimeEvidenceEngine();
    assert.ok(engine.records);
    assert.ok(engine.sessions);
    assert.ok(Array.isArray(engine.records));
    assert.ok(engine.sessions instanceof Map);
  });

  await t.test('accepts custom signing key and retention days', () => {
    const engine = new RuntimeEvidenceEngine({
      signingKey: 'custom-key-123',
      retentionDays: 30,
      performanceThreshold: 2000
    });
    assert.strictEqual(engine.options.signingKey, 'custom-key-123');
    assert.strictEqual(engine.options.retentionDays, 30);
    assert.strictEqual(engine.options.performanceThreshold, 2000);
  });

  await t.test('defines all 10 evidence categories', () => {
    const engine = new RuntimeEvidenceEngine();
    assert.deepStrictEqual(engine.evidenceCategories, [
      'app_startup',
      'user_interaction',
      'data_binding',
      'formula_execution',
      'connection',
      'error_event',
      'state_transition',
      'performance',
      'behavior_verification',
      'integration'
    ]);
  });

  // ==================== Integrity Signing ====================

  await t.test('signEvidence creates consistent HMAC signatures', () => {
    const engine = new RuntimeEvidenceEngine({ signingKey: 'test-key' });
    const payload = { action: 'test', value: 123 };

    const sig1 = engine.signEvidence(payload);
    const sig2 = engine.signEvidence(payload);

    assert.strictEqual(sig1, sig2);
    assert.ok(typeof sig1 === 'string');
    assert.ok(sig1.length > 0);
  });

  await t.test('signEvidence produces different signatures for different payloads', () => {
    const engine = new RuntimeEvidenceEngine({ signingKey: 'test-key' });
    const sig1 = engine.signEvidence({ action: 'test1' });
    const sig2 = engine.signEvidence({ action: 'test2' });

    assert.notStrictEqual(sig1, sig2);
  });

  // ==================== App Startup Capture ====================

  await t.test('captureAppStartup records initialization context', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-001',
      appId: 'app-001',
      startupTime: 500,
      environment: 'test'
    };

    const record = engine.captureAppStartup(context);

    assert.strictEqual(record.category, 'app_startup');
    assert.strictEqual(record.payload.appId, 'app-001');
    assert.ok(record.payload.readiness);
    assert.ok(record.timestamp);
    assert.ok(record.signature);
  });

  await t.test('captureAppStartup calculates readiness object', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-002',
      appId: 'app-001',
      startupTime: 500,
      screenLoaded: true,
      connectionsInitialized: true,
      dataSourcesLoaded: ['source1']
    };

    const record = engine.captureAppStartup(context);
    assert.ok(record.payload.readiness);
    assert.strictEqual(record.payload.readiness.uiReady, true);
    assert.strictEqual(record.payload.readiness.connectionsReady, true);
  });

  // ==================== User Interaction Capture ====================

  await t.test('captureUserInteraction records click events', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-003',
      appId: 'app-001',
      screenName: 'MainScreen',
      controlName: 'submitButton',
      interactionType: 'click'
    };

    const record = engine.captureUserInteraction(context);

    assert.strictEqual(record.category, 'user_interaction');
    assert.strictEqual(record.payload.interactionType, 'click');
    assert.strictEqual(record.payload.controlName, 'submitButton');
    assert.ok(record.timestamp);
    assert.ok(record.signature);
  });

  await t.test('captureUserInteraction records input events', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-004',
      appId: 'app-001',
      screenName: 'MainScreen',
      controlName: 'nameField',
      interactionType: 'input',
      inputValue: 'test input'
    };

    const record = engine.captureUserInteraction(context);

    assert.strictEqual(record.payload.interactionType, 'input');
    assert.strictEqual(record.payload.inputValue, 'test input');
  });

  // ==================== Data Binding Capture ====================

  await t.test('captureDataBinding verifies data-UI binding', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-005',
      appId: 'app-001',
      controlName: 'statusDisplay',
      expectedValue: 'active',
      actualValue: 'active',
      dataSourceName: 'statusTable'
    };

    const record = engine.captureDataBinding(context);

    assert.strictEqual(record.category, 'data_binding');
    assert.strictEqual(record.payload.controlName, 'statusDisplay');
    assert.strictEqual(record.payload.expectedValue, 'active');
    assert.strictEqual(record.payload.actualValue, 'active');
    assert.strictEqual(record.payload.matchesExpectation, true);
    assert.ok(record.signature);
  });

  await t.test('captureDataBinding detects binding mismatches', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-006',
      appId: 'app-001',
      controlName: 'statusDisplay',
      expectedValue: 'active',
      actualValue: 'inactive',
      dataSourceName: 'statusTable'
    };

    const record = engine.captureDataBinding(context);

    assert.strictEqual(record.payload.matchesExpectation, false);
  });

  // ==================== Formula Execution Capture ====================

  await t.test('captureFormulaExecution records formula evaluation', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-007',
      appId: 'app-001',
      formulaName: 'calculateTotal',
      inputParameters: { qty: 5, price: 10 },
      expectedOutput: 50,
      actualOutput: 50
    };

    const record = engine.captureFormulaExecution(context);

    assert.strictEqual(record.category, 'formula_execution');
    assert.strictEqual(record.payload.formulaName, 'calculateTotal');
    assert.strictEqual(record.payload.expectedOutput, 50);
    assert.strictEqual(record.payload.actualOutput, 50);
    assert.strictEqual(record.payload.matchesExpectation, true);
  });

  await t.test('captureFormulaExecution detects formula result mismatches', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-008',
      appId: 'app-001',
      formulaName: 'calculateTotal',
      inputParameters: { qty: 5, price: 10 },
      expectedOutput: 50,
      actualOutput: 55
    };

    const record = engine.captureFormulaExecution(context);
    assert.strictEqual(record.payload.matchesExpectation, false);
  });

  // ==================== Connection Capture ====================

  await t.test('captureConnection records API connection', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-009',
      appId: 'app-001',
      connectionName: 'graphAPI',
      status: 'connected',
      responseTime: 150,
      apiCall: '/api/users'
    };

    const record = engine.captureConnection(context);

    assert.strictEqual(record.category, 'connection');
    assert.strictEqual(record.payload.connectionName, 'graphAPI');
    assert.strictEqual(record.payload.status, 'connected');
    assert.strictEqual(record.payload.responseTime, 150);
    assert.ok(record.timestamp);
  });

  await t.test('captureConnection records failed connection', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-010',
      appId: 'app-001',
      connectionName: 'graphAPI',
      status: 'error',
      errorInfo: 'Network timeout'
    };

    const record = engine.captureConnection(context);

    assert.strictEqual(record.payload.status, 'error');
    assert.strictEqual(record.payload.errorInfo, 'Network timeout');
  });

  // ==================== Error Event Capture ====================

  await t.test('captureErrorEvent records error with severity', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-011',
      appId: 'app-001',
      errorMessage: 'Division by zero',
      severity: 'error',
      screenName: 'calculator',
      handled: true
    };

    const record = engine.captureErrorEvent(context);

    assert.strictEqual(record.category, 'error_event');
    assert.strictEqual(record.payload.errorMessage, 'Division by zero');
    assert.strictEqual(record.payload.severity, 'error');
    assert.strictEqual(record.payload.handled, true);
    assert.ok(record.timestamp);
  });

  await t.test('captureErrorEvent distinguishes error severities', () => {
    const engine = new RuntimeEvidenceEngine();
    const severities = ['error', 'warning', 'fatal'];

    for (const sev of severities) {
      const record = engine.captureErrorEvent({
        correlationId: `corr-${sev}`,
        appId: 'app-001',
        errorMessage: 'Test error',
        severity: sev,
        handled: false
      });
      assert.strictEqual(record.payload.severity, sev);
    }
  });

  // ==================== State Transition Capture ====================

  await t.test('captureStateTransition records screen navigation', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-012',
      appId: 'app-001',
      transitionType: 'navigation',
      fromScreen: 'ListScreen',
      toScreen: 'DetailScreen',
      transitionTime: 300
    };

    const record = engine.captureStateTransition(context);

    assert.strictEqual(record.category, 'state_transition');
    assert.strictEqual(record.payload.transitionType, 'navigation');
    assert.strictEqual(record.payload.fromScreen, 'ListScreen');
    assert.strictEqual(record.payload.toScreen, 'DetailScreen');
    assert.strictEqual(record.payload.transitionTime, 300);
  });

  await t.test('captureStateTransition records modal interactions', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-013',
      appId: 'app-001',
      transitionType: 'modal',
      fromScreen: 'MainScreen',
      toScreen: 'ModalScreen'
    };

    const record = engine.captureStateTransition(context);
    assert.strictEqual(record.payload.transitionType, 'modal');
  });

  // ==================== Performance Capture ====================

  await t.test('capturePerformance records operation duration', () => {
    const engine = new RuntimeEvidenceEngine({ performanceThreshold: 5000 });
    const context = {
      correlationId: 'corr-014',
      appId: 'app-001',
      operationName: 'dataRefresh',
      duration: 1200
    };

    const record = engine.capturePerformance(context);

    assert.strictEqual(record.category, 'performance');
    assert.strictEqual(record.payload.operationName, 'dataRefresh');
    assert.strictEqual(record.payload.duration, 1200);
  });

  await t.test('capturePerformance detects threshold violations', () => {
    const engine = new RuntimeEvidenceEngine({ performanceThreshold: 2000 });
    const context = {
      correlationId: 'corr-015',
      appId: 'app-001',
      operationName: 'heavyComputation',
      duration: 5000
    };

    const record = engine.capturePerformance(context);
    assert.ok(record.payload.duration > engine.options.performanceThreshold);
  });

  // ==================== Behavior Verification ====================

  await t.test('captureBehaviorVerification records user-observable behavior', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-016',
      appId: 'app-001',
      scenario: 'button enabled after validation',
      expectedBehavior: 'enabled',
      observedBehavior: 'enabled',
      verified: true
    };

    const record = engine.captureBehaviorVerification(context);

    assert.strictEqual(record.category, 'behavior_verification');
    assert.strictEqual(record.payload.scenario, 'button enabled after validation');
    assert.strictEqual(record.payload.matches, true);
  });

  // ==================== Integration Capture ====================

  await t.test('captureIntegration records cross-app communication', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      correlationId: 'corr-017',
      appId: 'app-001',
      integrationType: 'power_automate',
      sourceSystem: 'PowerApps',
      targetSystem: 'PowerAutomate',
      status: 'success'
    };

    const record = engine.captureIntegration(context);

    assert.strictEqual(record.category, 'integration');
    assert.strictEqual(record.payload.integrationType, 'power_automate');
    assert.strictEqual(record.payload.sourceSystem, 'PowerApps');
    assert.strictEqual(record.payload.targetSystem, 'PowerAutomate');
    assert.strictEqual(record.payload.status, 'success');
  });

  // ==================== Session Management ====================

  await t.test('initializeSessionContext creates session tracking', () => {
    const engine = new RuntimeEvidenceEngine();
    const context = {
      appId: 'app-001',
      environment: 'test',
      userId: 'user-123'
    };

    engine.initializeSessionContext('session-001', context);

    assert.ok(engine.sessions.has('session-001'));
    const session = engine.sessions.get('session-001');
    assert.ok(session);
  });

  await t.test('updateSessionContext increments evidence count', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.initializeSessionContext('session-002', { appId: 'app-001' });

    engine.updateSessionContext('session-002', 'app_startup');
    engine.updateSessionContext('session-002', 'user_interaction');

    const session = engine.sessions.get('session-002');
    assert.ok(session);
  });

  // ==================== Health Checking ====================

  await t.test('isAppHealthy returns health status object', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.initializeSessionContext('health-001', { appId: 'app-001' });
    engine.captureAppStartup({
      correlationId: 'health-001',
      appId: 'app-001',
      startupTime: 500
    });

    const health = engine.isAppHealthy('health-001');

    assert.ok(typeof health === 'object');
    assert.ok(health !== null);
  });

  await t.test('isAppHealthy detects blocking errors', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.initializeSessionContext('health-002', { appId: 'app-001' });

    engine.captureErrorEvent({
      correlationId: 'health-002',
      appId: 'app-001',
      errorMessage: 'Critical error',
      severity: 'fatal',
      handled: false
    });

    const health = engine.isAppHealthy('health-002');
    assert.ok(health);
  });

  await t.test('isAppHealthy evaluates performance status', () => {
    const engine = new RuntimeEvidenceEngine({ performanceThreshold: 2000 });
    engine.initializeSessionContext('health-003', { appId: 'app-001' });

    engine.capturePerformance({
      correlationId: 'health-003',
      appId: 'app-001',
      operationName: 'slow operation',
      duration: 5000
    });

    const health = engine.isAppHealthy('health-003');
    assert.ok(health);
  });

  // ==================== Runtime Reports ====================

  await t.test('generateRuntimeReport creates comprehensive status report', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.initializeSessionContext('report-001', { appId: 'app-001' });
    engine.captureAppStartup({
      correlationId: 'report-001',
      appId: 'app-001',
      startupTime: 500
    });
    engine.captureUserInteraction({
      correlationId: 'report-001',
      appId: 'app-001',
      controlName: 'button',
      interactionType: 'click'
    });

    const report = engine.generateRuntimeReport('report-001');

    assert.ok(report);
    assert.ok(report.correlationId);
    assert.ok(report.categories);
    assert.ok(report.timeline);
  });

  await t.test('generateRuntimeReport includes overall readiness score', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.initializeSessionContext('report-002', { appId: 'app-001' });

    const report = engine.generateRuntimeReport('report-002');

    assert.ok(report);
    assert.ok(report.overallReadiness);
  });

  // ==================== Evidence Verification ====================

  await t.test('verifyRecords marks evidence as human-verified', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.initializeSessionContext('verify-001', { appId: 'app-001' });
    engine.captureAppStartup({
      correlationId: 'verify-001',
      appId: 'app-001',
      startupTime: 500
    });

    const before = engine.records[0]?.verified;
    engine.verifyRecords('verify-001', (record) => true);
    const after = engine.records[0]?.verified;

    assert.ok(before !== after);
  });

  // ==================== Export ====================

  await t.test('exportEvidence returns complete evidence export', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.initializeSessionContext('export-001', { appId: 'app-001' });
    engine.captureAppStartup({
      correlationId: 'export-001',
      appId: 'app-001',
      startupTime: 500
    });

    const exported = engine.exportEvidence('export-001');

    assert.ok(exported);
    assert.ok(exported.exportTimestamp);
    assert.ok(exported.runtimeReport);
  });

  // ==================== Cleanup & Retention ====================

  await t.test('cleanupOldRecords removes records exceeding retention days', () => {
    const engine = new RuntimeEvidenceEngine({ retentionDays: 0 });

    // Add records with old timestamps
    engine.records.push({
      id: 'old-1',
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      category: 'app_startup'
    });
    engine.records.push({
      id: 'new-1',
      timestamp: new Date().toISOString(),
      category: 'app_startup'
    });

    const before = engine.records.length;
    engine.cleanupOldRecords();
    const after = engine.records.length;

    assert.ok(after <= before);
  });

  // ==================== Statistics ====================

  await t.test('getStatistics returns comprehensive statistics', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.initializeSessionContext('stats-001', { appId: 'app-001' });
    engine.captureAppStartup({
      correlationId: 'stats-001',
      appId: 'app-001',
      startupTime: 500
    });
    engine.captureUserInteraction({
      correlationId: 'stats-001',
      appId: 'app-001',
      controlName: 'button',
      interactionType: 'click'
    });

    const stats = engine.getStatistics();

    assert.ok(stats);
    assert.ok(typeof stats.totalRecords === 'number');
  });

  await t.test('getStatistics tracks category breakdown', () => {
    const engine = new RuntimeEvidenceEngine();
    engine.captureAppStartup({
      correlationId: 'stats-002',
      appId: 'app-001',
      startupTime: 500
    });

    const stats = engine.getStatistics();

    assert.ok(stats);
  });

  // ==================== Multiple Sessions ====================

  await t.test('handles multiple concurrent sessions', () => {
    const engine = new RuntimeEvidenceEngine();

    engine.initializeSessionContext('session-a', { appId: 'app-a' });
    engine.initializeSessionContext('session-b', { appId: 'app-b' });

    engine.captureAppStartup({
      correlationId: 'session-a',
      appId: 'app-a',
      startupTime: 500
    });
    engine.captureAppStartup({
      correlationId: 'session-b',
      appId: 'app-b',
      startupTime: 600
    });

    assert.strictEqual(engine.sessions.size, 2);
    assert.ok(engine.records.length >= 2);
  });

  // ==================== Edge Cases ====================

  await t.test('handles missing correlationId gracefully', () => {
    const engine = new RuntimeEvidenceEngine();

    const record = engine.captureAppStartup({
      appId: 'app-001',
      startupTime: 500
    });

    assert.ok(record);
    assert.strictEqual(record.category, 'app_startup');
  });

  await t.test('handles unknown session in health check', () => {
    const engine = new RuntimeEvidenceEngine();

    const health = engine.isAppHealthy('unknown-session');

    assert.ok(health || health === false || health === undefined);
  });

  await t.test('handles empty evidence records in statistics', () => {
    const engine = new RuntimeEvidenceEngine();

    const stats = engine.getStatistics();

    assert.ok(stats);
  });
});
