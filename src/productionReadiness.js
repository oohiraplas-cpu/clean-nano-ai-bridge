/**
 * Production Readiness: Pre-deployment checks and health verification
 *
 * Comprehensive checks before production deployment:
 * - Configuration validation
 * - Dependency health
 * - Security posture
 * - Performance baselines
 * - Data integrity
 * - Capacity planning
 */

/**
 * Configuration Validator
 */
class ConfigurationValidator {
  constructor() {
    this.requiredEnvVars = [
      'NODE_ENV',
      'PORT',
      'HOST'
    ];
    this.recommendations = [];
    this.errors = [];
  }

  /**
   * Validate configuration
   */
  validate(config) {
    const issues = {
      errors: [],
      warnings: [],
      recommendations: []
    };

    // Check required variables
    for (const varName of this.requiredEnvVars) {
      if (!config[varName]) {
        issues.errors.push(`Missing required config: ${varName}`);
      }
    }

    // Validate specific configs
    this._validateNodeEnv(config, issues);
    this._validatePortAndHost(config, issues);
    this._validateSecurityConfigs(config, issues);
    this._validateStorageConfigs(config, issues);
    this._validateCacheConfigs(config, issues);

    return {
      valid: issues.errors.length === 0,
      errors: issues.errors,
      warnings: issues.warnings,
      recommendations: issues.recommendations
    };
  }

  /**
   * Validate NODE_ENV
   */
  _validateNodeEnv(config, issues) {
    const validEnvs = ['development', 'test', 'staging', 'production'];
    if (config.NODE_ENV && !validEnvs.includes(config.NODE_ENV)) {
      issues.warnings.push(`Unusual NODE_ENV: ${config.NODE_ENV}`);
    }

    if (config.NODE_ENV === 'production') {
      if (!config.LOG_LEVEL || config.LOG_LEVEL === 'debug') {
        issues.warnings.push('DEBUG logging enabled in production');
      }
    }
  }

  /**
   * Validate PORT and HOST
   */
  _validatePortAndHost(config, issues) {
    if (config.PORT) {
      const port = parseInt(config.PORT);
      if (isNaN(port) || port < 1 || port > 65535) {
        issues.errors.push(`Invalid PORT: ${config.PORT}`);
      }
      if (port < 1024) {
        issues.warnings.push(`PORT ${port} requires elevated privileges`);
      }
    }

    if (config.HOST === '0.0.0.0' && config.NODE_ENV === 'production') {
      issues.warnings.push('HOST 0.0.0.0 exposes service to all interfaces in production');
    }
  }

  /**
   * Validate security configs
   */
  _validateSecurityConfigs(config, issues) {
    // Check for API keys
    if (!config.WEBHOOK_API_KEY) {
      issues.errors.push('Missing WEBHOOK_API_KEY');
    }
    if (!config.MCP_API_KEY) {
      issues.errors.push('Missing MCP_API_KEY');
    }

    // Check key length
    if (config.WEBHOOK_API_KEY && config.WEBHOOK_API_KEY.length < 32) {
      issues.warnings.push('WEBHOOK_API_KEY is too short (recommend 32+ chars)');
    }

    // Check for hardcoded secrets
    if (config.WEBHOOK_API_KEY && config.WEBHOOK_API_KEY === 'test-key') {
      issues.errors.push('Test API key found in production config');
    }
  }

  /**
   * Validate storage configs
   */
  _validateStorageConfigs(config, issues) {
    if (config.TASK_STORE_BACKEND === 'file' && !config.DATA_DIR) {
      issues.errors.push('DATA_DIR required for file-based task store');
    }

    if (config.TASK_STORE_BACKEND === 'sharepoint') {
      if (!config.SHAREPOINT_SITE_ID) {
        issues.errors.push('SHAREPOINT_SITE_ID required for SharePoint backend');
      }
      if (!config.SHAREPOINT_LIST_ID) {
        issues.errors.push('SHAREPOINT_LIST_ID required for SharePoint backend');
      }
    }
  }

  /**
   * Validate cache configs
   */
  _validateCacheConfigs(config, issues) {
    if (config.CACHE_TYPE && !['redis', 'memory'].includes(config.CACHE_TYPE)) {
      issues.errors.push(`Invalid CACHE_TYPE: ${config.CACHE_TYPE}`);
    }

    if (config.CACHE_TYPE === 'redis') {
      if (!config.REDIS_URL) {
        issues.errors.push('REDIS_URL required for Redis cache');
      }
    }
  }
}

/**
 * Dependency Health Checker
 */
class DependencyHealthChecker {
  constructor() {
    this.checks = new Map();
  }

  /**
   * Register health check
   */
  registerCheck(name, checker) {
    this.checks.set(name, checker);
  }

  /**
   * Run all checks
   */
  async runChecks() {
    const results = {
      timestamp: new Date().toISOString(),
      healthy: true,
      checks: {}
    };

    for (const [name, checker] of this.checks) {
      try {
        const result = await Promise.race([
          checker(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Check timeout')), 5000)
          )
        ]);

        results.checks[name] = {
          status: result.status || 'ok',
          message: result.message,
          details: result.details
        };

        if (result.status !== 'ok') {
          results.healthy = false;
        }
      } catch (error) {
        results.healthy = false;
        results.checks[name] = {
          status: 'error',
          message: error.message
        };
      }
    }

    return results;
  }
}

/**
 * Performance Baseline Checker
 */
class PerformanceBaseline {
  constructor() {
    this.baseline = null;
    this.current = null;
  }

  /**
   * Establish baseline
   */
  establishBaseline(metrics) {
    this.baseline = {
      timestamp: Date.now(),
      metrics: {
        avgLatency: metrics.avgLatency || 100,
        p95Latency: metrics.p95Latency || 500,
        p99Latency: metrics.p99Latency || 1000,
        errorRate: metrics.errorRate || 0.01,
        throughput: metrics.throughput || 100
      }
    };

    return this.baseline;
  }

  /**
   * Check current performance
   */
  check(metrics) {
    this.current = {
      timestamp: Date.now(),
      metrics
    };

    if (!this.baseline) {
      return {
        valid: true,
        message: 'No baseline established yet'
      };
    }

    const issues = [];
    const thresholds = {
      latency: 1.5, // 50% slower is concerning
      errorRate: 2.0, // 2x error rate is concerning
      throughput: 0.8 // 20% lower throughput is concerning
    };

    // Check latency
    if (metrics.avgLatency > this.baseline.metrics.avgLatency * thresholds.latency) {
      issues.push(`Average latency degraded: ${metrics.avgLatency}ms vs ${this.baseline.metrics.avgLatency}ms baseline`);
    }

    // Check error rate
    if (metrics.errorRate > this.baseline.metrics.errorRate * thresholds.errorRate) {
      issues.push(`Error rate increased: ${(metrics.errorRate * 100).toFixed(2)}% vs ${(this.baseline.metrics.errorRate * 100).toFixed(2)}% baseline`);
    }

    // Check throughput
    if (metrics.throughput < this.baseline.metrics.throughput * thresholds.throughput) {
      issues.push(`Throughput decreased: ${metrics.throughput} req/s vs ${this.baseline.metrics.throughput} req/s baseline`);
    }

    return {
      valid: issues.length === 0,
      issues,
      comparison: {
        latency: {
          baseline: this.baseline.metrics.avgLatency,
          current: metrics.avgLatency,
          ratio: metrics.avgLatency / this.baseline.metrics.avgLatency
        },
        errorRate: {
          baseline: this.baseline.metrics.errorRate,
          current: metrics.errorRate,
          ratio: metrics.errorRate / this.baseline.metrics.errorRate
        },
        throughput: {
          baseline: this.baseline.metrics.throughput,
          current: metrics.throughput,
          ratio: metrics.throughput / this.baseline.metrics.throughput
        }
      }
    };
  }
}

/**
 * Data Integrity Checker
 */
class DataIntegrityChecker {
  constructor() {
    this.checks = [];
  }

  /**
   * Register integrity check
   */
  registerCheck(name, checker) {
    this.checks.push({ name, checker });
  }

  /**
   * Run checks
   */
  async runChecks() {
    const results = {
      timestamp: new Date().toISOString(),
      healthy: true,
      checks: []
    };

    for (const check of this.checks) {
      try {
        const result = await check.checker();
        results.checks.push({
          name: check.name,
          status: result.status || 'ok',
          message: result.message,
          details: result.details
        });

        if (result.status !== 'ok') {
          results.healthy = false;
        }
      } catch (error) {
        results.healthy = false;
        results.checks.push({
          name: check.name,
          status: 'error',
          message: error.message
        });
      }
    }

    return results;
  }
}

/**
 * Capacity Planner
 */
class CapacityPlanner {
  constructor() {
    this.metrics = null;
    this.projections = null;
  }

  /**
   * Analyze current usage
   */
  analyzeUsage(metrics) {
    this.metrics = {
      timestamp: Date.now(),
      ...metrics
    };

    return this.metrics;
  }

  /**
   * Project capacity
   */
  projectCapacity(growthRate = 1.2, months = 12) {
    if (!this.metrics) {
      return null;
    }

    const projections = [];

    for (let m = 1; m <= months; m++) {
      const multiplier = Math.pow(growthRate, m);
      projections.push({
        month: m,
        projectedUsers: Math.ceil((this.metrics.users || 0) * multiplier),
        projectedStorage: Math.ceil((this.metrics.storageGB || 0) * multiplier),
        projectedThroughput: Math.ceil((this.metrics.throughput || 0) * multiplier),
        warning: multiplier > 2 ? 'Approaching capacity limits' : null
      });
    }

    this.projections = projections;
    return projections;
  }

  /**
   * Get capacity recommendations
   */
  getRecommendations() {
    if (!this.projections || !this.metrics) {
      return [];
    }

    const recommendations = [];

    const maxThroughput = 10000; // req/s
    const maxStorage = 1000; // GB
    const maxUsers = 100000;

    const finalProjection = this.projections[this.projections.length - 1];

    if (finalProjection.projectedThroughput > maxThroughput * 0.8) {
      recommendations.push('Consider load balancing infrastructure upgrade');
    }

    if (finalProjection.projectedStorage > maxStorage * 0.8) {
      recommendations.push('Plan storage expansion strategy');
    }

    if (finalProjection.projectedUsers > maxUsers * 0.8) {
      recommendations.push('Consider horizontal scaling architecture');
    }

    return recommendations;
  }
}

/**
 * Production Readiness Checker: Orchestrates all checks
 */
class ProductionReadinessChecker {
  constructor(options = {}) {
    this.configValidator = new ConfigurationValidator();
    this.dependencyChecker = new DependencyHealthChecker();
    this.performanceBaseline = new PerformanceBaseline();
    this.dataIntegrityChecker = new DataIntegrityChecker();
    this.capacityPlanner = new CapacityPlanner();
    this.results = null;
  }

  /**
   * Run full readiness check
   */
  async runFullCheck(config, metrics = {}) {
    const results = {
      timestamp: new Date().toISOString(),
      ready: true,
      sections: {}
    };

    // 1. Configuration validation
    results.sections.configuration = this.configValidator.validate(config);
    if (!results.sections.configuration.valid) {
      results.ready = false;
    }

    // 2. Dependency health
    results.sections.dependencies = await this.dependencyChecker.runChecks();
    if (!results.sections.dependencies.healthy) {
      results.ready = false;
    }

    // 3. Performance baseline
    if (metrics && Object.keys(metrics).length > 0) {
      results.sections.performance = this.performanceBaseline.check(metrics);
      if (!results.sections.performance.valid) {
        results.ready = false;
      }
    }

    // 4. Data integrity
    results.sections.dataIntegrity = await this.dataIntegrityChecker.runChecks();
    if (!results.sections.dataIntegrity.healthy) {
      results.ready = false;
    }

    // 5. Capacity planning
    if (metrics && metrics.users !== undefined) {
      results.sections.capacity = {
        current: this.capacityPlanner.analyzeUsage(metrics),
        projections: this.capacityPlanner.projectCapacity(),
        recommendations: this.capacityPlanner.getRecommendations()
      };
    }

    this.results = results;
    return results;
  }

  /**
   * Get readiness summary
   */
  getSummary() {
    if (!this.results) {
      return null;
    }

    return {
      ready: this.results.ready,
      timestamp: this.results.timestamp,
      sections: {
        configuration: this.results.sections.configuration?.valid ? 'pass' : 'fail',
        dependencies: this.results.sections.dependencies?.healthy ? 'pass' : 'fail',
        performance: this.results.sections.performance?.valid ? 'pass' : 'warning',
        dataIntegrity: this.results.sections.dataIntegrity?.healthy ? 'pass' : 'fail',
        capacity: this.results.sections.capacity ? 'pass' : 'not_checked'
      },
      blockingIssues: [
        ...( this.results.sections.configuration?.errors || []),
        ...Object.values(this.results.sections.dependencies?.checks || {})
          .filter(c => c.status === 'error')
          .map(c => c.message)
      ]
    };
  }
}

module.exports = {
  ConfigurationValidator,
  DependencyHealthChecker,
  PerformanceBaseline,
  DataIntegrityChecker,
  CapacityPlanner,
  ProductionReadinessChecker
};
