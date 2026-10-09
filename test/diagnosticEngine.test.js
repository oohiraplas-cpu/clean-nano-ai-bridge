const test = require('node:test');
const assert = require('node:assert');
const {
  DIAGNOSTIC_CODES,
  DiagnosticEngine
} = require('../src/diagnosticEngine');

test('Diagnostic Engine', async (t) => {
  await t.test('creates diagnostic engine with default config', () => {
    const engine = new DiagnosticEngine();

    assert.ok(engine);
    assert.strictEqual(engine.lastDiagnostics, null);
  });

  await t.test('runs diagnostics with no services configured', async () => {
    const engine = new DiagnosticEngine();

    const result = await engine.runDiagnostics();

    assert.ok(result.timestamp);
    assert.ok(result.categories);
    assert.ok(result.issues);
    assert.ok(result.recommendations);
  });

  await t.test('returns healthy status when all services configured', async () => {
    const mockStore = {
      getStats: () => ({
        count: 10,
        percentUsed: 5,
        expiredCount: 0,
        avgSizeBytes: 1024
      })
    };

    const mockAuthService = {
      getStatistics: () => ({
        approvedCount: 100,
        rejectedCount: 10
      })
    };

    const mockPolicyEngine = {
      getSummary: () => ({
        totalPolicies: 12
      })
    };

    const mockTxManager = {
      getStatistics: () => ({
        total: 100,
        successful: 90,
        failed: 5,
        inProgress: 5
      })
    };

    const mockLedger = {
      verifyIntegrity: () => ({
        valid: true,
        errors: [],
        totalRecords: 50000
      }),
      getStatistics: () => ({
        totalRecords: 50000
      })
    };

    const engine = new DiagnosticEngine({
      stateContextStore: mockStore,
      authorizationService: mockAuthService,
      policyEngine: mockPolicyEngine,
      transactionManager: mockTxManager,
      evidenceLedger: mockLedger
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.stateContext.status, DIAGNOSTIC_CODES.HEALTHY);
    assert.strictEqual(result.status, DIAGNOSTIC_CODES.HEALTHY);
    assert.strictEqual(result.isHealthy, true);
  });

  await t.test('diagnoses state context near capacity', async () => {
    const mockStore = {
      getStats: () => ({
        count: 950,
        percentUsed: 95,
        expiredCount: 0
      })
    };

    const engine = new DiagnosticEngine({
      stateContextStore: mockStore
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.stateContext.status, DIAGNOSTIC_CODES.DEGRADED);
    assert.ok(result.issues.some(i => i.code === 'STATE_CONTEXT_NEAR_CAPACITY'));
  });

  await t.test('diagnoses excessive expired contexts', async () => {
    const mockStore = {
      getStats: () => ({
        count: 500,
        percentUsed: 50,
        expiredCount: 150
      })
    };

    const engine = new DiagnosticEngine({
      stateContextStore: mockStore
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.stateContext.status, DIAGNOSTIC_CODES.DEGRADED);
    assert.ok(result.issues.some(i => i.code === 'EXCESSIVE_EXPIRED_CONTEXTS'));
  });

  await t.test('returns unknown for unconfigured state context', async () => {
    const engine = new DiagnosticEngine({
      stateContextStore: null
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.stateContext.status, DIAGNOSTIC_CODES.UNKNOWN);
  });

  await t.test('diagnoses authorization rejection rate', async () => {
    const mockAuthService = {
      getStatistics: () => ({
        approvedCount: 20,
        rejectedCount: 80
      })
    };

    const engine = new DiagnosticEngine({
      authorizationService: mockAuthService
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.authorization.status, DIAGNOSTIC_CODES.DEGRADED);
  });

  await t.test('detects missing policies', async () => {
    const mockPolicyEngine = {
      getSummary: () => ({
        totalPolicies: 0
      })
    };

    const engine = new DiagnosticEngine({
      policyEngine: mockPolicyEngine
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.policies.status, DIAGNOSTIC_CODES.CRITICAL);
    assert.ok(result.issues.some(i => i.code === 'NO_POLICIES_LOADED'));
  });

  await t.test('diagnoses transaction health', async () => {
    const mockTxManager = {
      getStatistics: () => ({
        total: 1000,
        successful: 850,
        failed: 100,
        inProgress: 50
      })
    };

    const engine = new DiagnosticEngine({
      transactionManager: mockTxManager
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.transactions.status, DIAGNOSTIC_CODES.HEALTHY);
  });

  await t.test('diagnoses excessive in-progress transactions', async () => {
    const mockTxManager = {
      getStatistics: () => ({
        total: 1000,
        successful: 500,
        failed: 200,
        inProgress: 300
      })
    };

    const engine = new DiagnosticEngine({
      transactionManager: mockTxManager
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.transactions.status, DIAGNOSTIC_CODES.DEGRADED);
    assert.ok(result.issues.some(i => i.code === 'EXCESSIVE_IN_PROGRESS'));
  });

  await t.test('diagnoses high transaction failure rate', async () => {
    const mockTxManager = {
      getStatistics: () => ({
        total: 100,
        successful: 50,
        failed: 40,
        inProgress: 10
      })
    };

    const engine = new DiagnosticEngine({
      transactionManager: mockTxManager
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.transactions.status, DIAGNOSTIC_CODES.DEGRADED);
    assert.ok(result.issues.some(i => i.code === 'HIGH_FAILURE_RATE'));
  });

  await t.test('detects audit ledger tampering', async () => {
    const mockLedger = {
      verifyIntegrity: () => ({
        valid: false,
        errors: [
          { error: 'Hash mismatch' },
          { error: 'Hash chain broken' }
        ],
        totalRecords: 100
      }),
      getStatistics: () => ({
        totalRecords: 100
      })
    };

    const engine = new DiagnosticEngine({
      evidenceLedger: mockLedger
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.auditLedger.status, DIAGNOSTIC_CODES.CRITICAL);
    assert.ok(result.issues.some(i => i.code === 'AUDIT_LEDGER_TAMPERED'));
  });

  await t.test('diagnoses audit ledger near capacity', async () => {
    const mockLedger = {
      verifyIntegrity: () => ({
        valid: true,
        errors: [],
        totalRecords: 98000
      }),
      getStatistics: () => ({
        totalRecords: 98000
      })
    };

    const engine = new DiagnosticEngine({
      evidenceLedger: mockLedger
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.auditLedger.status, DIAGNOSTIC_CODES.DEGRADED);
    assert.ok(result.issues.some(i => i.code === 'AUDIT_LEDGER_NEAR_CAPACITY'));
  });

  await t.test('overall status becomes CRITICAL when critical category found', async () => {
    const mockPolicies = {
      getSummary: () => ({ totalPolicies: 0 })
    };

    const mockLedger = {
      verifyIntegrity: () => ({
        valid: true,
        errors: [],
        totalRecords: 50000
      }),
      getStatistics: () => ({
        totalRecords: 50000
      })
    };

    const engine = new DiagnosticEngine({
      policyEngine: mockPolicies,
      evidenceLedger: mockLedger
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.status, DIAGNOSTIC_CODES.CRITICAL);
  });

  await t.test('overall status becomes DEGRADED when degraded category found', async () => {
    const mockStore = {
      getStats: () => ({
        count: 950,
        percentUsed: 95,
        expiredCount: 0
      })
    };

    const engine = new DiagnosticEngine({
      stateContextStore: mockStore
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.status, DIAGNOSTIC_CODES.DEGRADED);
  });

  await t.test('generates capacity cleanup recommendation', async () => {
    const mockStore = {
      getStats: () => ({
        count: 950,
        percentUsed: 95,
        expiredCount: 100
      })
    };

    const engine = new DiagnosticEngine({
      stateContextStore: mockStore
    });

    const result = await engine.runDiagnostics();

    assert.ok(result.recommendations.some(r => r.action === 'cleanup_expired_contexts'));
  });

  await t.test('generates policy reload recommendation', async () => {
    const mockPolicies = {
      getSummary: () => ({ totalPolicies: 0 })
    };

    const engine = new DiagnosticEngine({
      policyEngine: mockPolicies
    });

    const result = await engine.runDiagnostics();

    assert.ok(result.recommendations.some(r => r.action === 'reload_default_policies'));
  });

  await t.test('generates transaction investigation recommendation', async () => {
    const mockTxManager = {
      getStatistics: () => ({
        total: 1000,
        successful: 500,
        failed: 200,
        inProgress: 300
      })
    };

    const engine = new DiagnosticEngine({
      transactionManager: mockTxManager
    });

    const result = await engine.runDiagnostics();

    assert.ok(result.recommendations.some(r => r.action === 'review_stuck_transactions'));
  });

  await t.test('generates critical audit ledger alert', async () => {
    const mockLedger = {
      verifyIntegrity: () => ({
        valid: false,
        errors: [{ error: 'Hash mismatch' }],
        totalRecords: 100
      }),
      getStatistics: () => ({
        totalRecords: 100
      })
    };

    const engine = new DiagnosticEngine({
      evidenceLedger: mockLedger
    });

    const result = await engine.runDiagnostics();

    assert.ok(result.recommendations.some(r => r.action === 'audit_ledger_integrity_alert'));
  });

  await t.test('stores last diagnostics result', async () => {
    const engine = new DiagnosticEngine();

    assert.strictEqual(engine.getLastDiagnostics(), null);

    await engine.runDiagnostics();

    const last = engine.getLastDiagnostics();
    assert.ok(last);
    assert.ok(last.timestamp);
  });

  await t.test('provides health summary', async () => {
    const engine = new DiagnosticEngine();

    const summaryBefore = engine.getHealthSummary();
    assert.strictEqual(summaryBefore.status, DIAGNOSTIC_CODES.UNKNOWN);

    await engine.runDiagnostics();

    const summaryAfter = engine.getHealthSummary();
    assert.ok(summaryAfter.status);
    assert.ok(typeof summaryAfter.isHealthy === 'boolean');
    assert.ok(typeof summaryAfter.issueCount === 'number');
    assert.ok(typeof summaryAfter.recommendationCount === 'number');
  });

  await t.test('handles service errors gracefully', async () => {
    const mockBadService = {
      getStats: () => {
        throw new Error('Service unavailable');
      }
    };

    const engine = new DiagnosticEngine({
      stateContextStore: mockBadService
    });

    const result = await engine.runDiagnostics();

    assert.strictEqual(result.categories.stateContext.status, DIAGNOSTIC_CODES.CRITICAL);
    assert.ok(result.issues.some(i => i.code === 'STATE_CONTEXT_CHECK_FAILED'));
  });

  await t.test('provides issue details for troubleshooting', async () => {
    const mockStore = {
      getStats: () => ({
        count: 950,
        percentUsed: 95,
        expiredCount: 0
      })
    };

    const engine = new DiagnosticEngine({
      stateContextStore: mockStore
    });

    const result = await engine.runDiagnostics();

    const capacityIssue = result.issues.find(i => i.code === 'STATE_CONTEXT_NEAR_CAPACITY');
    assert.ok(capacityIssue);
    assert.ok(capacityIssue.percentUsed);
    assert.strictEqual(capacityIssue.percentUsed, 95);
  });
});
