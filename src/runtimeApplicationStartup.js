/**
 * Runtime Application Startup
 *
 * Orchestrates complete Bridge application startup sequence:
 * - Environment validation and loading
 * - Dependency initialization in dependency order
 * - Configuration verification
 * - Component readiness checks
 * - Graceful shutdown handling
 * - Startup monitoring and diagnostics
 *
 * Provides complete application lifecycle management from boot to readiness.
 */

/**
 * Environment loader and validator
 * Loads and validates runtime environment configuration
 */
class EnvironmentLoader {
  constructor() {
    this.environment = {};
    this.required = [];
    this.optional = [];
    this.loadHistory = [];
    this.validationErrors = [];
  }

  /**
   * Define required environment variable
   * @param {string} name - Variable name
   * @param {string} description - Variable description
   * @param {Function} validator - Optional validation function
   */
  requireVariable(name, description, validator = null) {
    this.required.push({ name, description, validator });
  }

  /**
   * Define optional environment variable with default
   * @param {string} name - Variable name
   * @param {*} defaultValue - Default value if not set
   * @param {string} description - Variable description
   * @param {Function} validator - Optional validation function
   */
  defineOptional(name, defaultValue, description, validator = null) {
    this.optional.push({ name, defaultValue, description, validator });
  }

  /**
   * Load environment from process.env
   * @returns {Object} Load result with success status and any errors
   */
  loadFromProcess() {
    const result = {
      success: true,
      loaded: 0,
      missing: [],
      invalid: [],
      timestamp: Date.now()
    };

    // Load required variables
    for (const req of this.required) {
      const value = process.env[req.name];
      if (!value) {
        result.success = false;
        result.missing.push(req.name);
        this.validationErrors.push(`Required: ${req.name} (${req.description})`);
        continue;
      }

      // Validate if validator provided
      if (req.validator && !req.validator(value)) {
        result.success = false;
        result.invalid.push(req.name);
        this.validationErrors.push(`Invalid: ${req.name} failed validation`);
        continue;
      }

      this.environment[req.name] = value;
      result.loaded++;
    }

    // Load optional variables
    for (const opt of this.optional) {
      const value = process.env[opt.name] !== undefined ? process.env[opt.name] : opt.defaultValue;

      // Validate if validator provided
      if (opt.validator && !opt.validator(value)) {
        result.success = false;
        result.invalid.push(opt.name);
        this.validationErrors.push(`Invalid: ${opt.name} failed validation`);
        continue;
      }

      this.environment[opt.name] = value;
      result.loaded++;
    }

    this.loadHistory.push(result);
    return result;
  }

  /**
   * Get loaded environment
   * @returns {Object} Environment variables
   */
  getEnvironment() {
    return { ...this.environment };
  }

  /**
   * Get validation errors
   * @returns {Array} Array of error messages
   */
  getErrors() {
    return [...this.validationErrors];
  }

  /**
   * Get load history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.loadHistory];
  }
}

/**
 * Dependency initializer with topological ordering
 * Initializes components respecting dependency graph
 */
class DependencyInitializer {
  constructor() {
    this.dependencies = new Map();
    this.initializers = new Map();
    this.initialized = new Map();
    this.initializationOrder = [];
    this.initHistory = [];
    this.initErrors = [];
  }

  /**
   * Define component initializer
   * @param {string} name - Component name
   * @param {Array} depends - Array of component names this depends on
   * @param {Function} initializer - Async initializer function
   */
  defineComponent(name, depends, initializer) {
    if (!Array.isArray(depends)) {
      throw new Error('depends must be an array');
    }
    if (typeof initializer !== 'function') {
      throw new Error('initializer must be a function');
    }

    this.dependencies.set(name, depends);
    this.initializers.set(name, initializer);
  }

  /**
   * Compute initialization order using topological sort
   * @returns {Object} Order result with components and any cycles detected
   */
  computeOrder() {
    const result = {
      success: true,
      order: [],
      cycles: []
    };

    const visited = new Set();
    const visiting = new Set();

    const visit = (name) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        result.success = false;
        result.cycles.push(name);
        return;
      }

      visiting.add(name);

      const deps = this.dependencies.get(name) || [];
      for (const dep of deps) {
        if (this.dependencies.has(dep)) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      result.order.push(name);
    };

    for (const name of this.dependencies.keys()) {
      visit(name);
    }

    this.initializationOrder = result.order;
    return result;
  }

  /**
   * Initialize all components in dependency order
   * @returns {Promise<Object>} Initialization result
   */
  async initializeAll() {
    const result = {
      success: true,
      initialized: [],
      failed: [],
      errors: [],
      startTime: Date.now()
    };

    const orderResult = this.computeOrder();
    if (!orderResult.success) {
      result.success = false;
      result.errors.push(`Circular dependencies detected: ${orderResult.cycles.join(', ')}`);
      return result;
    }

    // Initialize in order
    for (const componentName of orderResult.order) {
      try {
        const initializer = this.initializers.get(componentName);
        const startTime = Date.now();

        await initializer();

        const duration = Date.now() - startTime;
        this.initialized.set(componentName, {
          success: true,
          timestamp: Date.now(),
          duration
        });

        result.initialized.push({
          name: componentName,
          duration
        });
      } catch (error) {
        result.success = false;
        result.failed.push(componentName);
        result.errors.push(`${componentName}: ${error.message}`);
        this.initErrors.push({
          component: componentName,
          error: error.message,
          timestamp: Date.now()
        });
      }
    }

    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

    this.initHistory.push(result);
    return result;
  }

  /**
   * Get initialization status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      initialized: this.initialized.size,
      failed: this.initErrors.length,
      total: this.dependencies.size,
      completionPercent: this.dependencies.size > 0 ? (this.initialized.size / this.dependencies.size * 100).toFixed(1) : 0
    };
  }

  /**
   * Get initialization history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.initHistory];
  }
}

/**
 * Configuration validator with schema checking
 * Validates that all required configuration is present and valid
 */
class ConfigurationValidator {
  constructor() {
    this.schemas = new Map();
    this.validationHistory = [];
  }

  /**
   * Define configuration schema
   * @param {string} section - Configuration section name
   * @param {Object} schema - Schema with required and optional fields
   */
  defineSchema(section, schema) {
    if (!schema || typeof schema !== 'object') {
      throw new Error('Schema must be an object');
    }
    this.schemas.set(section, schema);
  }

  /**
   * Validate configuration against schemas
   * @param {Object} config - Configuration object to validate
   * @returns {Object} Validation result
   */
  validateConfig(config) {
    const result = {
      valid: true,
      sections: [],
      issues: [],
      timestamp: Date.now()
    };

    for (const [section, schema] of this.schemas.entries()) {
      const sectionConfig = config[section] || {};
      const sectionResult = {
        section,
        valid: true,
        missing: [],
        invalid: []
      };

      // Check required fields
      if (schema.required) {
        for (const field of schema.required) {
          if (!(field in sectionConfig)) {
            sectionResult.valid = false;
            sectionResult.missing.push(field);
            result.valid = false;
          }
        }
      }

      // Validate optional fields if present
      if (schema.optional && schema.validators) {
        for (const field of schema.optional) {
          if (field in sectionConfig) {
            const validator = schema.validators[field];
            if (validator && !validator(sectionConfig[field])) {
              sectionResult.valid = false;
              sectionResult.invalid.push(field);
              result.valid = false;
            }
          }
        }
      }

      result.sections.push(sectionResult);
    }

    this.validationHistory.push(result);
    return result;
  }

  /**
   * Get validation history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.validationHistory];
  }
}

/**
 * Startup sequence orchestrator
 * Coordinates complete application startup from environment loading through readiness
 */
class StartupSequence {
  constructor() {
    this.envLoader = new EnvironmentLoader();
    this.depInitializer = new DependencyInitializer();
    this.configValidator = new ConfigurationValidator();
    this.startTime = null;
    this.endTime = null;
    this.status = 'not_started';
    this.shutdownHandlers = [];
  }

  /**
   * Configure startup sequence
   * @param {Object} options - Configuration options
   */
  configure(options = {}) {
    // Store configuration for later reference
    this.config = options;
  }

  /**
   * Register shutdown handler (called on SIGTERM/SIGINT)
   * @param {Function} handler - Async handler function
   */
  onShutdown(handler) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function');
    }
    this.shutdownHandlers.push(handler);
  }

  /**
   * Execute complete startup sequence
   * @returns {Promise<Object>} Startup result
   */
  async startup() {
    this.startTime = Date.now();
    this.status = 'starting';

    const result = {
      success: true,
      phases: {
        environment: null,
        dependencies: null,
        configuration: null
      },
      errors: [],
      startTime: this.startTime,
      endTime: null,
      duration: null
    };

    try {
      // Phase 1: Load environment
      const envResult = this.envLoader.loadFromProcess();
      result.phases.environment = envResult;
      if (!envResult.success) {
        result.success = false;
        result.errors.push(`Environment loading failed: ${this.envLoader.getErrors().join(', ')}`);
      }

      // Phase 2: Initialize dependencies
      const depResult = await this.depInitializer.initializeAll();
      result.phases.dependencies = depResult;
      if (!depResult.success) {
        result.success = false;
        result.errors = result.errors.concat(depResult.errors);
      }

      // Phase 3: Validate configuration
      const config = this.envLoader.getEnvironment();
      const configResult = this.configValidator.validateConfig(config);
      result.phases.configuration = configResult;
      if (!configResult.valid) {
        result.success = false;
        for (const section of configResult.sections) {
          if (!section.valid) {
            result.errors.push(`Configuration invalid in ${section.section}: missing ${section.missing.join(', ')}, invalid ${section.invalid.join(', ')}`);
          }
        }
      }

      this.status = result.success ? 'ready' : 'failed';
    } catch (error) {
      result.success = false;
      result.errors.push(`Startup error: ${error.message}`);
      this.status = 'error';
    }

    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;

    return result;
  }

  /**
   * Execute shutdown sequence
   * @returns {Promise<Object>} Shutdown result
   */
  async shutdown() {
    const result = {
      success: true,
      handlersExecuted: 0,
      errors: [],
      startTime: Date.now()
    };

    for (const handler of this.shutdownHandlers) {
      try {
        await handler();
        result.handlersExecuted++;
      } catch (error) {
        result.success = false;
        result.errors.push(error.message);
      }
    }

    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;
    this.status = 'shutdown';

    return result;
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  setupSignalHandlers() {
    const signals = ['SIGTERM', 'SIGINT'];
    for (const signal of signals) {
      process.on(signal, async () => {
        console.log(`Received ${signal}, shutting down...`);
        const shutdownResult = await this.shutdown();
        process.exit(shutdownResult.success ? 0 : 1);
      });
    }
  }

  /**
   * Get startup status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      status: this.status,
      environment: this.envLoader.getEnvironment() ? Object.keys(this.envLoader.getEnvironment()).length : 0,
      dependencies: this.depInitializer.getStatus(),
      startTime: this.startTime,
      uptime: this.startTime ? Date.now() - this.startTime : null
    };
  }
}

/**
 * Application bootstrap helper
 * Simplified entry point for application startup
 */
class ApplicationBootstrap {
  static async initialize(options = {}) {
    const startup = new StartupSequence();
    startup.configure(options);

    // Setup signal handlers
    startup.setupSignalHandlers();

    // Execute startup
    const result = await startup.startup();

    return {
      startup,
      result,
      ready: result.success
    };
  }

  /**
   * Create bootstrap from existing components
   * @param {Object} components - Existing component instances
   * @returns {Object} Bootstrap instance
   */
  static async initializeWithComponents(components = {}) {
    const startup = new StartupSequence();
    startup.setupSignalHandlers();

    // If components provided, mark as ready
    if (Object.keys(components).length > 0) {
      const result = await startup.startup();
      return { startup, result, ready: result.success };
    }

    return { startup, result: null, ready: false };
  }
}

module.exports = {
  EnvironmentLoader,
  DependencyInitializer,
  ConfigurationValidator,
  StartupSequence,
  ApplicationBootstrap
};
