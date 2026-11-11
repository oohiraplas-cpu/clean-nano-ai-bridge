const test = require('node:test');
const assert = require('node:assert');
const {
  ConfigurationValidator,
  DependencyHealthChecker,
  PerformanceBaseline,
  DataIntegrityChecker,
  CapacityPlanner,
  ProductionReadinessChecker
} = require('../src/productionReadiness');

test('Production Readiness', async (t) => {
  await t.test('ConfigurationValidator', async (t) => {
    await t.test('validates required config', () => {
      const validator = new ConfigurationValidator();

      const result = validator.validate({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        WEBHOOK_API_KEY: 'secret-key-1234567890',
        MCP_API_KEY: 'secret-key-1234567890'
      });

      assert.strictEqual(result.valid, true);
    });

    await t.test('fails on missing required config', () => {
      const validator = new ConfigurationValidator();

      const result = validator.validate({
        NODE_ENV: 'production'
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    await t.test('warns on debug logging in production', () => {
      const validator = new ConfigurationValidator();

      const result = validator.validate({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        LOG_LEVEL: 'debug'
      });

      assert.ok(result.warnings.length > 0);
    });

    await t.test('validates port range', () => {
      const validator = new ConfigurationValidator();

      const result1 = validator.validate({
        NODE_ENV: 'production',
        PORT: '65536',
        HOST: '0.0.0.0'
      });

      assert.strictEqual(result1.valid, false);
    });

    await t.test('checks API keys', () => {
      const validator = new ConfigurationValidator();

      const result = validator.validate({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0'
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('WEBHOOK_API_KEY')));
    });

    await t.test('validates API key length', () => {
      const validator = new ConfigurationValidator();

      const result = validator.validate({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        WEBHOOK_API_KEY: 'short',
        MCP_API_KEY: 'short'
      });

      assert.ok(result.warnings.length > 0);
    });

    await t.test('detects test keys in production', () => {
      const validator = new ConfigurationValidator();

      const result = validator.validate({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        WEBHOOK_API_KEY: 'test-key'
      });

      assert.strictEqual(result.valid, false);
    });
  });

  await t.test('DependencyHealthChecker', async (t) => {
    await t.test('registers health checks', () => {
      const checker = new DependencyHealthChecker();

      checker.registerCheck('database', async () => ({
        status: 'ok',
        message: 'Connected'
      }));

      assert.strictEqual(checker.checks.size, 1);
    });

    await t.test('runs health checks', async () => {
      const checker = new DependencyHealthChecker();

      checker.registerCheck('database', async () => ({
        status: 'ok',
        message: 'Connected'
      }));

      const results = await checker.runChecks();
      assert.strictEqual(results.healthy, true);
      assert.ok(results.checks.database);
    });

    await t.test('marks unhealthy on failed checks', async () => {
      const checker = new DependencyHealthChecker();

      checker.registerCheck('database', async () => ({
        status: 'error',
        message: 'Connection failed'
      }));

      const results = await checker.runChecks();
      assert.strictEqual(results.healthy, false);
    });

    await t.test('handles check timeouts', async () => {
      const checker = new DependencyHealthChecker();

      checker.registerCheck('slow', async () => {
        return new Promise(resolve => {
          setTimeout(() => resolve({ status: 'ok' }), 10000);
        });
      });

      const results = await checker.runChecks();
      assert.strictEqual(results.healthy, false);
      assert.ok(results.checks.slow.message.includes('timeout'));
    });
  });

  await t.test('PerformanceBaseline', async (t) => {
    await t.test('establishes baseline', () => {
      const baseline = new PerformanceBaseline();

      baseline.establishBaseline({
        avgLatency: 100,
        p95Latency: 500,
        p99Latency: 1000,
        errorRate: 0.01,
        throughput: 100
      });

      assert.ok(baseline.baseline);
      assert.strictEqual(baseline.baseline.metrics.avgLatency, 100);
    });

    await t.test('compares current performance against baseline', () => {
      const baseline = new PerformanceBaseline();

      baseline.establishBaseline({
        avgLatency: 100,
        p95Latency: 500,
        errorRate: 0.01,
        throughput: 100
      });

      const result = baseline.check({
        avgLatency: 120,
        p95Latency: 500,
        errorRate: 0.01,
        throughput: 100
      });

      assert.strictEqual(result.valid, true);
    });

    await t.test('detects latency degradation', () => {
      const baseline = new PerformanceBaseline();

      baseline.establishBaseline({
        avgLatency: 100,
        p95Latency: 500,
        errorRate: 0.01,
        throughput: 100
      });

      const result = baseline.check({
        avgLatency: 200,
        p95Latency: 500,
        errorRate: 0.01,
        throughput: 100
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.issues.some(i => i.includes('latency degraded')));
    });

    await t.test('detects error rate increase', () => {
      const baseline = new PerformanceBaseline();

      baseline.establishBaseline({
        avgLatency: 100,
        p95Latency: 500,
        errorRate: 0.01,
        throughput: 100
      });

      const result = baseline.check({
        avgLatency: 100,
        p95Latency: 500,
        errorRate: 0.03,
        throughput: 100
      });

      assert.strictEqual(result.valid, false);
    });

    await t.test('detects throughput decrease', () => {
      const baseline = new PerformanceBaseline();

      baseline.establishBaseline({
        avgLatency: 100,
        p95Latency: 500,
        errorRate: 0.01,
        throughput: 100
      });

      const result = baseline.check({
        avgLatency: 100,
        p95Latency: 500,
        errorRate: 0.01,
        throughput: 70
      });

      assert.strictEqual(result.valid, false);
    });
  });

  await t.test('DataIntegrityChecker', async (t) => {
    await t.test('registers integrity checks', () => {
      const checker = new DataIntegrityChecker();

      checker.registerCheck('audit_log', async () => ({
        status: 'ok',
        message: 'No corruption'
      }));

      assert.strictEqual(checker.checks.length, 1);
    });

    await t.test('runs integrity checks', async () => {
      const checker = new DataIntegrityChecker();

      checker.registerCheck('audit_log', async () => ({
        status: 'ok',
        message: 'Verified'
      }));

      const results = await checker.runChecks();
      assert.strictEqual(results.healthy, true);
    });

    await t.test('reports unhealthy when checks fail', async () => {
      const checker = new DataIntegrityChecker();

      checker.registerCheck('audit_log', async () => ({
        status: 'error',
        message: 'Hash mismatch'
      }));

      const results = await checker.runChecks();
      assert.strictEqual(results.healthy, false);
    });
  });

  await t.test('CapacityPlanner', async (t) => {
    await t.test('analyzes current usage', () => {
      const planner = new CapacityPlanner();

      planner.analyzeUsage({
        users: 1000,
        storageGB: 50,
        throughput: 100
      });

      assert.ok(planner.metrics);
    });

    await t.test('projects capacity growth', () => {
      const planner = new CapacityPlanner();

      planner.analyzeUsage({
        users: 1000,
        storageGB: 50,
        throughput: 100
      });

      const projections = planner.projectCapacity(1.2, 12);

      assert.strictEqual(projections.length, 12);
      assert.ok(projections[0].projectedUsers > 1000);
      assert.ok(projections[11].projectedUsers > projections[0].projectedUsers);
    });

    await t.test('generates capacity recommendations', () => {
      const planner = new CapacityPlanner();

      planner.analyzeUsage({
        users: 90000,
        storageGB: 800,
        throughput: 9000
      });

      planner.projectCapacity(1.2, 12);
      const recommendations = planner.getRecommendations();

      assert.ok(recommendations.length > 0);
    });
  });

  await t.test('ProductionReadinessChecker', async (t) => {
    await t.test('runs full readiness check', async () => {
      const checker = new ProductionReadinessChecker();

      const result = await checker.runFullCheck({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        WEBHOOK_API_KEY: 'secret-key-1234567890',
        MCP_API_KEY: 'secret-key-1234567890'
      });

      assert.ok(result.timestamp);
      assert.ok(result.sections);
    });

    await t.test('marks as not ready on configuration errors', async () => {
      const checker = new ProductionReadinessChecker();

      const result = await checker.runFullCheck({
        NODE_ENV: 'production'
      });

      assert.strictEqual(result.ready, false);
    });

    await t.test('includes performance baseline in check', async () => {
      const checker = new ProductionReadinessChecker();

      const result = await checker.runFullCheck({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        WEBHOOK_API_KEY: 'secret-1234567890',
        MCP_API_KEY: 'secret-1234567890'
      }, {
        avgLatency: 100,
        errorRate: 0.01,
        throughput: 100
      });

      assert.ok(result.sections.performance);
    });

    await t.test('includes capacity planning in check', async () => {
      const checker = new ProductionReadinessChecker();

      const result = await checker.runFullCheck({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        WEBHOOK_API_KEY: 'secret-1234567890',
        MCP_API_KEY: 'secret-1234567890'
      }, {
        users: 1000,
        storageGB: 50,
        throughput: 100
      });

      assert.ok(result.sections.capacity);
    });

    await t.test('gets readiness summary', async () => {
      const checker = new ProductionReadinessChecker();

      await checker.runFullCheck({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '0.0.0.0',
        WEBHOOK_API_KEY: 'secret-1234567890',
        MCP_API_KEY: 'secret-1234567890'
      });

      const summary = checker.getSummary();
      assert.ok(summary.ready !== undefined);
      assert.ok(summary.sections);
      assert.ok(summary.blockingIssues);
    });
  });
});
