const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const {
  HealthCheckRegistry,
  DependencyVerifier,
  RemediationAdvisor,
  ComprehensiveHealthCheck
} = require('../src/healthCheckSystem');

test('HealthCheckRegistry', async t => {
  await t.test('records health check results', () => {
    const registry = new HealthCheckRegistry();
    const componentId = 'auth-service';
    const result = {
      healthy: true,
      metrics: { responseTime: 45 },
      version: '1.0.0'
    };

    const record = registry.recordCheck(componentId, result);

    assert.ok(record.checkId);
    assert.equal(record.status, 'healthy');
    assert.ok(record.timestamp);
  });

  await t.test('throws on invalid componentId', () => {
    const registry = new HealthCheckRegistry();
    assert.throws(
      () => registry.recordCheck(null, { healthy: true }),
      /Invalid componentId/
    );
  });

  await t.test('throws on invalid result', () => {
    const registry = new HealthCheckRegistry();
    assert.throws(
      () => registry.recordCheck('service', null),
      /Invalid result/
    );
  });

  await t.test('getStatus returns recorded check', () => {
    const registry = new HealthCheckRegistry();
    const componentId = 'db-service';
    const result = { healthy: true, metrics: { connections: 42 } };

    registry.recordCheck(componentId, result);
    const status = registry.getStatus(componentId);

    assert.equal(status.componentId, componentId);
    assert.equal(status.status, 'healthy');
    assert.deepEqual(status.metrics, { connections: 42 });
  });

  await t.test('getAllStatus returns summary', () => {
    const registry = new HealthCheckRegistry();

    registry.recordCheck('service-1', { healthy: true });
    registry.recordCheck('service-2', { healthy: true });
    registry.recordCheck('service-3', { healthy: false });

    const allStatus = registry.getAllStatus();

    assert.equal(allStatus.summary.totalComponents, 3);
    assert.equal(allStatus.summary.healthyCount, 2);
    assert.equal(allStatus.summary.unhealthyCount, 1);
    assert.equal(allStatus.summary.overallStatus, 'unhealthy');
  });

  await t.test('getHistory returns component history', () => {
    const registry = new HealthCheckRegistry();
    const componentId = 'api-service';

    registry.recordCheck(componentId, { healthy: true });
    registry.recordCheck(componentId, { healthy: false });
    registry.recordCheck(componentId, { healthy: true });

    const history = registry.getHistory(componentId);

    assert.equal(history.length, 3);
    assert.equal(history[0].status, 'healthy');
    assert.equal(history[1].status, 'unhealthy');
    assert.equal(history[2].status, 'healthy');
  });

  await t.test('getStatusWindow returns recent status within time window', () => {
    const registry = new HealthCheckRegistry();
    const componentId = 'cache-service';

    const now = Date.now();
    registry.recordCheck(componentId, { healthy: true });

    const window = registry.getStatusWindow(componentId, 60);
    assert.ok(window.length > 0);
  });

  await t.test('detectStatusChange identifies status transitions', () => {
    const registry = new HealthCheckRegistry();
    const componentId = 'queue-service';

    registry.recordCheck(componentId, { healthy: true });
    registry.recordCheck(componentId, { healthy: false });

    const change = registry.detectStatusChange(componentId);

    assert.equal(change.componentId, componentId);
    assert.equal(change.from, 'healthy');
    assert.equal(change.to, 'unhealthy');
  });

  await t.test('detectStatusChange returns null when no change', () => {
    const registry = new HealthCheckRegistry();
    const componentId = 'storage-service';

    registry.recordCheck(componentId, { healthy: true });
    registry.recordCheck(componentId, { healthy: true });

    const change = registry.detectStatusChange(componentId);

    assert.equal(change, null);
  });

  await t.test('enforces maximum history size per component', () => {
    const registry = new HealthCheckRegistry({ maxHistoryPerComponent: 5 });
    const componentId = 'bounded-service';

    for (let i = 0; i < 10; i++) {
      registry.recordCheck(componentId, { healthy: i % 2 === 0 });
    }

    const history = registry.getHistory(componentId);
    assert.ok(history.length <= 5);
  });

  await t.test('getStats returns registry statistics', () => {
    const registry = new HealthCheckRegistry();

    registry.recordCheck('svc-1', { healthy: true });
    registry.recordCheck('svc-2', { healthy: false });
    registry.recordCheck('svc-1', { healthy: true });

    const stats = registry.getStats();

    assert.equal(stats.registeredComponents, 2);
    assert.equal(stats.totalHistoryRecords, 3);
  });
});

test('DependencyVerifier', async t => {
  await t.test('defines component dependencies', () => {
    const verifier = new DependencyVerifier();

    const result = verifier.defineDependency('api', ['db', 'cache']);

    assert.equal(result.componentId, 'api');
    assert.deepEqual(result.dependsOn, ['db', 'cache']);
  });

  await t.test('throws on invalid componentId in defineDependency', () => {
    const verifier = new DependencyVerifier();
    assert.throws(
      () => verifier.defineDependency(null, ['db']),
      /Invalid componentId/
    );
  });

  await t.test('throws when dependsOn is not an array', () => {
    const verifier = new DependencyVerifier();
    assert.throws(
      () => verifier.defineDependency('api', 'db'),
      /must be an array/
    );
  });

  await t.test('verifyDependencies with no dependencies', () => {
    const verifier = new DependencyVerifier();
    const registry = new HealthCheckRegistry();

    const result = verifier.verifyDependencies('standalone', registry);

    assert.equal(result.verified, true);
    assert.equal(result.noDependencies, true);
    assert.equal(result.issues.length, 0);
  });

  await t.test('verifyDependencies detects missing dependencies', () => {
    const verifier = new DependencyVerifier();
    const registry = new HealthCheckRegistry();

    verifier.defineDependency('api', ['db', 'cache']);

    const result = verifier.verifyDependencies('api', registry);

    assert.equal(result.verified, false);
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues.some(i => i.dependency === 'db'));
  });

  await t.test('verifyDependencies passes when all dependencies healthy', () => {
    const verifier = new DependencyVerifier();
    const registry = new HealthCheckRegistry();

    registry.recordCheck('db', { healthy: true });
    registry.recordCheck('cache', { healthy: true });

    verifier.defineDependency('api', ['db', 'cache']);

    const result = verifier.verifyDependencies('api', registry);

    assert.equal(result.verified, true);
    assert.equal(result.issues.length, 0);
  });

  await t.test('verifyDependencies fails when dependency is unhealthy', () => {
    const verifier = new DependencyVerifier();
    const registry = new HealthCheckRegistry();

    registry.recordCheck('db', { healthy: false, severity: 'error' });
    registry.recordCheck('cache', { healthy: true });

    verifier.defineDependency('api', ['db', 'cache']);

    const result = verifier.verifyDependencies('api', registry);

    assert.equal(result.verified, false);
    assert.ok(result.issues.some(i => i.dependency === 'db'));
  });

  await t.test('verifyNoCircularDependencies passes for valid graph', () => {
    const verifier = new DependencyVerifier();

    verifier.defineDependency('api', ['db', 'cache']);
    verifier.defineDependency('db', ['storage']);
    verifier.defineDependency('cache', []);

    const result = verifier.verifyNoCircularDependencies();

    assert.equal(result.valid, true);
  });

  await t.test('verifyNoCircularDependencies detects cycles', () => {
    const verifier = new DependencyVerifier();

    verifier.defineDependency('a', ['b']);
    verifier.defineDependency('b', ['c']);
    verifier.defineDependency('c', ['a']);

    const result = verifier.verifyNoCircularDependencies();

    assert.equal(result.valid, false);
    assert.match(result.reason, /Circular/);
  });

  await t.test('getDependencyGraph returns full graph', () => {
    const verifier = new DependencyVerifier();

    verifier.defineDependency('api', ['db', 'cache']);
    verifier.defineDependency('db', ['storage']);

    const graph = verifier.getDependencyGraph();

    assert.deepEqual(graph.api, ['db', 'cache']);
    assert.deepEqual(graph.db, ['storage']);
  });
});

test('RemediationAdvisor', async t => {
  await t.test('defines remediation rules', () => {
    const advisor = new RemediationAdvisor();

    const result = advisor.defineRemediationRule('service_down', {
      description: 'Service is not responding',
      steps: ['Restart service', 'Verify logs'],
      priority: 'high',
      autoFixable: true
    });

    assert.equal(result.issueType, 'service_down');
    assert.equal(result.registered, true);
  });

  await t.test('throws on invalid issueType', () => {
    const advisor = new RemediationAdvisor();
    assert.throws(
      () => advisor.defineRemediationRule(null, {}),
      /Invalid issueType/
    );
  });

  await t.test('throws on invalid rule', () => {
    const advisor = new RemediationAdvisor();
    assert.throws(
      () => advisor.defineRemediationRule('issue', null),
      /Invalid rule/
    );
  });

  await t.test('generateRecommendation for known issue type', () => {
    const advisor = new RemediationAdvisor();

    advisor.defineRemediationRule('high_latency', {
      description: 'Response time is too high',
      steps: ['Check load', 'Scale up'],
      priority: 'medium'
    });

    const recommendation = advisor.generateRecommendation('high_latency');

    assert.equal(recommendation.available, true);
    assert.equal(recommendation.description, 'Response time is too high');
    assert.equal(recommendation.steps.length, 2);
  });

  await t.test('generateRecommendation for unknown issue type', () => {
    const advisor = new RemediationAdvisor();

    const recommendation = advisor.generateRecommendation('unknown_issue');

    assert.equal(recommendation.available, false);
    assert.match(recommendation.message, /No remediation rule/);
  });

  await t.test('generateActionPlan for multiple issues', () => {
    const advisor = new RemediationAdvisor();

    advisor.defineRemediationRule('error', {
      description: 'An error occurred',
      autoFixable: true
    });
    advisor.defineRemediationRule('warning', {
      description: 'A warning occurred',
      autoFixable: false,
      requiresApproval: true
    });

    const plan = advisor.generateActionPlan([
      { type: 'error', componentId: 'svc-1', severity: 'error' },
      { type: 'warning', componentId: 'svc-2', severity: 'warning' }
    ]);

    assert.equal(plan.totalIssues, 2);
    assert.ok(plan.autoFixableCount > 0);
    assert.equal(plan.requiresApproval, true);
  });

  await t.test('getRules returns all defined rules', () => {
    const advisor = new RemediationAdvisor();

    advisor.defineRemediationRule('rule1', { description: 'First' });
    advisor.defineRemediationRule('rule2', { description: 'Second' });

    const rules = advisor.getRules();

    assert.equal(rules.length, 2);
    assert.ok(rules.some(r => r.issueType === 'rule1'));
  });

  await t.test('getStats returns advisor statistics', () => {
    const advisor = new RemediationAdvisor();

    advisor.defineRemediationRule('issue1', { description: 'Issue' });
    advisor.generateRecommendation('issue1');

    const stats = advisor.getStats();

    assert.equal(stats.definedRules, 1);
    assert.equal(stats.recommendationsGenerated, 1);
  });
});

test('ComprehensiveHealthCheck', async t => {
  await t.test('executeFullCheck runs all checks', async () => {
    const checker = new ComprehensiveHealthCheck();

    const checks = [
      async () => ({ componentId: 'auth', healthy: true }),
      async () => ({ componentId: 'db', healthy: true })
    ];

    const result = await checker.executeFullCheck(checks);

    assert.equal(result.results.length, 2);
    assert.equal(result.summary.totalComponents, 2);
    assert.equal(result.summary.healthyCount, 2);
  });

  await t.test('executeFullCheck handles check errors', async () => {
    const checker = new ComprehensiveHealthCheck();

    const checks = [
      async () => { throw new Error('Check failed'); }
    ];

    const result = await checker.executeFullCheck(checks);

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, 'error');
  });

  await t.test('generateHealthReport provides comprehensive overview', async () => {
    const checker = new ComprehensiveHealthCheck();

    checker.registry.recordCheck('svc-1', { healthy: true });
    checker.registry.recordCheck('svc-2', { healthy: false, severity: 'error' });

    checker.verifier.defineDependency('svc-1', ['svc-2']);
    checker.advisor.defineRemediationRule('error', {
      description: 'Service error',
      autoFixable: false
    });

    const report = checker.generateHealthReport();

    assert.ok(report.timestamp);
    assert.equal(report.health.overallStatus, 'unhealthy');
    assert.equal(report.health.totalComponents, 2);
    assert.equal(report.issues.length, 1);
    assert.ok(report.actionPlan);
  });

  await t.test('health report shows no issues when all healthy', () => {
    const checker = new ComprehensiveHealthCheck();

    checker.registry.recordCheck('svc-1', { healthy: true });
    checker.registry.recordCheck('svc-2', { healthy: true });

    const report = checker.generateHealthReport();

    assert.equal(report.health.overallStatus, 'healthy');
    assert.equal(report.issues.length, 0);
    assert.equal(report.actionPlan, null);
  });

  await t.test('integration: complete health check workflow', async () => {
    const checker = new ComprehensiveHealthCheck();

    // Define dependencies
    checker.verifier.defineDependency('api', ['db', 'cache']);
    checker.verifier.defineDependency('db', []);
    checker.verifier.defineDependency('cache', []);

    // Define remediation rules
    checker.advisor.defineRemediationRule('connectivity_error', {
      description: 'Cannot reach service',
      steps: ['Check network', 'Restart service'],
      priority: 'high',
      autoFixable: false,
      requiresApproval: true
    });

    // Execute checks
    const checks = [
      async () => ({ componentId: 'api', healthy: false, severity: 'error', issues: ['Timeout'] }),
      async () => ({ componentId: 'db', healthy: true, metrics: { connections: 10 } }),
      async () => ({ componentId: 'cache', healthy: true, metrics: { hitRate: 0.95 } })
    ];

    const checkResult = await checker.executeFullCheck(checks);

    // Verify dependencies
    const depVerify = checker.verifier.verifyDependencies('api', checker.registry);

    // Generate report
    const report = checker.generateHealthReport();

    assert.equal(checkResult.summary.unhealthyCount, 1);
    assert.equal(depVerify.verified, true); // db and cache are both healthy
    assert.equal(report.health.overallStatus, 'unhealthy'); // api itself is unhealthy
    assert.ok(report.actionPlan);
  });
});
