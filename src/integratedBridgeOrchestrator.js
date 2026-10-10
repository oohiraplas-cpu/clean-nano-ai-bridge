/**
 * Integrated Bridge Orchestrator
 *
 * Coordinates all Bridge components (Phase 1-17) into unified operation:
 * - Component registration and lifecycle management
 * - Integration validation across all components
 * - Complete request/response orchestration pipeline
 * - Health aggregation across all systems
 * - Fail-Closed enforcement at all integration points
 *
 * Provides the central coordination point for all Bridge operations,
 * ensuring Fail-Closed behavior and complete traceability.
 */

/**
 * Registry for managing all Bridge components
 * Tracks dependencies, versions, and initialization state
 */
class BridgeComponentRegistry {
  constructor() {
    this.components = new Map();
    this.dependencies = new Map();
    this.initializationOrder = [];
    this.componentVersions = new Map();
    this.registrationHistory = [];
  }

  /**
   * Register a Bridge component
   * @param {string} name - Component name
   * @param {Object} component - Component instance
   * @param {Object} metadata - Component metadata
   */
  registerComponent(name, component, metadata = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('Component name must be non-empty string');
    }
    if (!component || typeof component !== 'object') {
      throw new Error('Component must be an object');
    }

    const componentData = {
      name,
      component,
      version: metadata.version || '1.0.0',
      phase: metadata.phase,
      dependencies: metadata.dependencies || [],
      initialized: false,
      registeredAt: Date.now()
    };

    this.components.set(name, componentData);
    this.componentVersions.set(name, componentData.version);

    if (metadata.dependencies && metadata.dependencies.length > 0) {
      this.dependencies.set(name, metadata.dependencies);
    }

    this.registrationHistory.push({
      action: 'register',
      component: name,
      timestamp: Date.now()
    });
  }

  /**
   * Get registered component
   * @param {string} name - Component name
   * @returns {Object|null} Component data or null
   */
  getComponent(name) {
    return this.components.get(name) || null;
  }

  /**
   * Get all registered components
   * @returns {Array} Array of component data
   */
  getAllComponents() {
    return Array.from(this.components.values());
  }

  /**
   * Mark component as initialized
   * @param {string} name - Component name
   */
  markInitialized(name) {
    const componentData = this.components.get(name);
    if (componentData) {
      componentData.initialized = true;
      this.registrationHistory.push({
        action: 'initialized',
        component: name,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Verify component dependencies are registered
   * @param {string} name - Component name
   * @returns {Object} Dependency verification result
   */
  verifyDependencies(name) {
    const result = {
      component: name,
      hasDependencies: false,
      satisfied: true,
      missingDependencies: [],
      checks: []
    };

    const deps = this.dependencies.get(name);
    if (!deps || deps.length === 0) {
      return result;
    }

    result.hasDependencies = true;

    for (const dep of deps) {
      const depData = this.components.get(dep);
      const satisfied = !!depData;
      result.checks.push({
        dependency: dep,
        registered: satisfied,
        initialized: depData ? depData.initialized : false
      });

      if (!satisfied) {
        result.satisfied = false;
        result.missingDependencies.push(dep);
      }
    }

    return result;
  }

  /**
   * Get component initialization order
   * @returns {Array} Ordered component names respecting dependencies
   */
  computeInitializationOrder() {
    const order = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (name) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving ${name}`);
      }

      visiting.add(name);

      const deps = this.dependencies.get(name) || [];
      for (const dep of deps) {
        if (this.components.has(dep)) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.components.keys()) {
      visit(name);
    }

    return order;
  }

  /**
   * Get registry statistics
   * @returns {Object} Registry stats
   */
  getStats() {
    const components = this.getAllComponents();
    const initialized = components.filter(c => c.initialized).length;

    return {
      totalComponents: components.length,
      initializedComponents: initialized,
      pendingComponents: components.length - initialized,
      versions: Object.fromEntries(this.componentVersions)
    };
  }

  /**
   * Get registration history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.registrationHistory];
  }
}

/**
 * Validates integration between all Bridge components
 * Ensures compatibility and correct wiring
 */
class IntegrationValidator {
  constructor(registry) {
    this.registry = registry;
    this.validationResults = [];
  }

  /**
   * Validate all component integrations
   * @returns {Object} Complete validation result
   */
  validateIntegrations() {
    const result = {
      valid: true,
      components: [],
      issues: [],
      warnings: []
    };

    for (const componentData of this.registry.getAllComponents()) {
      const depResult = this.registry.verifyDependencies(componentData.name);

      result.components.push({
        name: componentData.name,
        phase: componentData.phase,
        initialized: componentData.initialized,
        dependenciesSatisfied: depResult.satisfied
      });

      if (!depResult.satisfied) {
        result.valid = false;
        result.issues.push(
          `Component ${componentData.name} has unsatisfied dependencies: ${depResult.missingDependencies.join(', ')}`
        );
      }
    }

    // Validate initialization order
    try {
      this.registry.computeInitializationOrder();
    } catch (error) {
      result.valid = false;
      result.issues.push(error.message);
    }

    // Check for uninitialized components with satisfied dependencies
    for (const componentData of this.registry.getAllComponents()) {
      if (!componentData.initialized) {
        const depResult = this.registry.verifyDependencies(componentData.name);
        if (depResult.satisfied) {
          result.warnings.push(`Uninitialized component with satisfied dependencies: ${componentData.name}`);
        }
      }
    }

    this.validationResults.push({
      timestamp: Date.now(),
      valid: result.valid,
      componentCount: result.components.length,
      issueCount: result.issues.length
    });

    return result;
  }

  /**
   * Validate component interface
   * @param {string} componentName - Component name
   * @param {Array} requiredMethods - Required methods
   * @returns {Object} Interface validation result
   */
  validateComponentInterface(componentName, requiredMethods) {
    const result = {
      component: componentName,
      valid: true,
      presentMethods: [],
      missingMethods: []
    };

    const componentData = this.registry.getComponent(componentName);
    if (!componentData) {
      result.valid = false;
      result.missingMethods = requiredMethods;
      return result;
    }

    const component = componentData.component;
    for (const method of requiredMethods) {
      if (typeof component[method] === 'function') {
        result.presentMethods.push(method);
      } else {
        result.valid = false;
        result.missingMethods.push(method);
      }
    }

    return result;
  }

  /**
   * Get validation history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.validationResults];
  }
}

/**
 * Main orchestration engine coordinating complete Bridge operations
 * Handles request ingestion, component flow, and response generation
 */
class BridgeOrchestrationEngine {
  constructor(registry) {
    this.registry = registry;
    this.validator = new IntegrationValidator(registry);
    this.executionHistory = [];
    this.activeOperations = new Map();
  }

  /**
   * Execute complete Bridge operation pipeline
   * @param {Object} request - Incoming request
   * @param {Object} pipeline - Pipeline definition with steps
   * @returns {Object} Pipeline execution result
   */
  async executePipeline(request, pipeline) {
    if (!request || !pipeline || !Array.isArray(pipeline.steps)) {
      throw new Error('Invalid request or pipeline');
    }

    const operationId = `bridge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const result = {
      operationId,
      success: false,
      steps: [],
      errors: [],
      startTime: Date.now()
    };

    this.activeOperations.set(operationId, result);

    try {
      // Validate integration before execution
      const validationResult = this.validator.validateIntegrations();
      if (!validationResult.valid) {
        throw new Error(`Integration validation failed: ${validationResult.issues.join(', ')}`);
      }

      // Execute pipeline steps
      let pipelineContext = { request, result: {} };

      for (const step of pipeline.steps) {
        const stepResult = await this.executeStep(step, pipelineContext);

        result.steps.push({
          name: step.name,
          success: stepResult.success,
          duration: stepResult.duration
        });

        if (!stepResult.success) {
          result.errors.push(`Step ${step.name} failed: ${stepResult.error}`);
          break;
        }

        // Update context for next step
        if (stepResult.context) {
          pipelineContext = { ...pipelineContext, ...stepResult.context };
        }
      }

      result.success = result.errors.length === 0;
      result.finalContext = pipelineContext;
    } catch (error) {
      result.success = false;
      result.errors.push(error.message);
    }

    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

    this.recordExecution(result);
    this.activeOperations.delete(operationId);

    return result;
  }

  /**
   * Execute single pipeline step
   * @param {Object} step - Step definition
   * @param {Object} context - Execution context
   * @returns {Object} Step execution result
   */
  async executeStep(step, context) {
    const stepResult = {
      name: step.name,
      success: false,
      startTime: Date.now(),
      error: null,
      context: null
    };

    try {
      if (!step.component || !step.method) {
        throw new Error('Step must have component and method');
      }

      const componentData = this.registry.getComponent(step.component);
      if (!componentData) {
        throw new Error(`Component not found: ${step.component}`);
      }

      const component = componentData.component;
      if (typeof component[step.method] !== 'function') {
        throw new Error(`Method not found: ${step.component}.${step.method}`);
      }

      // Execute component method
      const methodResult = await component[step.method](context);

      stepResult.success = true;
      stepResult.context = methodResult;
    } catch (error) {
      stepResult.success = false;
      stepResult.error = error.message;
    }

    stepResult.endTime = Date.now();
    stepResult.duration = stepResult.endTime - stepResult.startTime;

    return stepResult;
  }

  /**
   * Record execution in history
   * @param {Object} result - Execution result
   */
  recordExecution(result) {
    this.executionHistory.push({
      operationId: result.operationId,
      success: result.success,
      duration: result.duration,
      stepCount: result.steps.length,
      errorCount: result.errors.length,
      timestamp: Date.now()
    });

    // Limit history size
    if (this.executionHistory.length > 1000) {
      this.executionHistory = this.executionHistory.slice(-1000);
    }
  }

  /**
   * Get execution history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.executionHistory];
  }

  /**
   * Get active operations
   * @returns {Array} Active operation results
   */
  getActiveOperations() {
    return Array.from(this.activeOperations.values());
  }
}

/**
 * Aggregates health status from all Bridge components
 * Provides unified health view for monitoring
 */
class BridgeHealthAggregator {
  constructor(registry) {
    this.registry = registry;
    this.healthSnapshots = [];
  }

  /**
   * Aggregate health from all components
   * @returns {Object} Aggregated health report
   */
  aggregateHealth() {
    const report = {
      timestamp: Date.now(),
      overallStatus: 'healthy',
      components: [],
      issues: [],
      summary: {
        total: 0,
        healthy: 0,
        unhealthy: 0,
        unknown: 0
      }
    };

    for (const componentData of this.registry.getAllComponents()) {
      const componentHealth = {
        name: componentData.name,
        phase: componentData.phase,
        status: this.getComponentStatus(componentData),
        initialized: componentData.initialized
      };

      // Check dependency health
      const depResult = this.registry.verifyDependencies(componentData.name);
      if (!depResult.satisfied) {
        componentHealth.status = 'unhealthy';
        report.issues.push(`Component ${componentData.name} has unsatisfied dependencies`);
      }

      report.components.push(componentHealth);
      report.summary.total++;

      if (componentHealth.status === 'healthy') {
        report.summary.healthy++;
      } else if (componentHealth.status === 'unhealthy') {
        report.summary.unhealthy++;
        report.issues.push(`Component ${componentData.name} is unhealthy`);
      } else {
        report.summary.unknown++;
      }
    }

    // Determine overall status
    if (report.summary.unhealthy > 0) {
      report.overallStatus = 'unhealthy';
    } else if (report.summary.unknown > 0) {
      report.overallStatus = 'degraded';
    }

    this.healthSnapshots.push(report);

    // Limit snapshots
    if (this.healthSnapshots.length > 100) {
      this.healthSnapshots = this.healthSnapshots.slice(-100);
    }

    return report;
  }

  /**
   * Get component health status
   * @param {Object} componentData - Component data
   * @returns {string} Health status
   */
  getComponentStatus(componentData) {
    if (!componentData.initialized) {
      return 'unknown';
    }

    // Check if component has health check method
    const component = componentData.component;
    if (typeof component.health === 'function') {
      const health = component.health();
      return health.status || 'unknown';
    }

    return 'healthy';
  }

  /**
   * Get health snapshots
   * @param {number} limit - Maximum entries to return
   * @returns {Array} Health snapshots
   */
  getSnapshots(limit = 50) {
    return this.healthSnapshots.slice(-limit);
  }
}

module.exports = {
  BridgeComponentRegistry,
  IntegrationValidator,
  BridgeOrchestrationEngine,
  BridgeHealthAggregator
};
