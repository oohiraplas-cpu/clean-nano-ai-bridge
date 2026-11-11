/**
 * Application Startup Orchestrator
 *
 * Manages the complete application startup sequence with:
 * - Phased initialization (init → validate → load → ready)
 * - Pre-condition validation before each phase transition
 * - Automatic recovery on startup failures
 * - Startup event tracking and history
 * - Phase dependency management
 *
 * Ensures all components are initialized in correct order and ready state
 * before accepting operational requests (Fail-Closed).
 */

const crypto = require('crypto');

/**
 * Manages startup sequence phases and transitions
 * Tracks current phase, execution timing, and completion status
 */
class StartupSequenceManager {
  constructor() {
    this.phases = ['init', 'validate', 'load', 'ready'];
    this.currentPhase = null;
    this.completedPhases = [];
    this.phaseTimings = {};
    this.startTime = null;
    this.phaseErrors = {};
  }

  /**
   * Start a new phase
   * @param {string} phaseName - Phase to start
   * @returns {Object} Phase start info
   */
  startPhase(phaseName) {
    if (!this.phases.includes(phaseName)) {
      throw new Error(`Invalid phase: ${phaseName}`);
    }

    if (this.currentPhase && !this.completedPhases.includes(this.currentPhase)) {
      throw new Error(`Cannot start ${phaseName}: ${this.currentPhase} phase not completed`);
    }

    const phaseIndex = this.phases.indexOf(phaseName);
    const lastCompletedIndex = this.completedPhases.length > 0
      ? this.phases.indexOf(this.completedPhases[this.completedPhases.length - 1])
      : -1;

    if (phaseIndex !== lastCompletedIndex + 1) {
      throw new Error(`Cannot start ${phaseName}: phases must be sequential`);
    }

    this.currentPhase = phaseName;
    this.phaseTimings[phaseName] = { start: Date.now() };

    if (!this.startTime) {
      this.startTime = Date.now();
    }

    return { phase: phaseName, startTime: this.phaseTimings[phaseName].start };
  }

  /**
   * Complete current phase
   * @param {Object} result - Phase completion result
   * @returns {Object} Phase completion info
   */
  completePhase(result) {
    if (!this.currentPhase) {
      throw new Error('No phase currently executing');
    }

    const endTime = Date.now();
    this.phaseTimings[this.currentPhase].end = endTime;
    this.phaseTimings[this.currentPhase].duration = endTime - this.phaseTimings[this.currentPhase].start;

    this.completedPhases.push(this.currentPhase);
    const completedPhase = this.currentPhase;
    this.currentPhase = null;

    return {
      phase: completedPhase,
      duration: this.phaseTimings[completedPhase].duration,
      result
    };
  }

  /**
   * Record error in phase
   * @param {string} phaseName - Phase that failed
   * @param {Error} error - Error object
   */
  recordPhaseError(phaseName, error) {
    if (!this.phaseErrors[phaseName]) {
      this.phaseErrors[phaseName] = [];
    }
    this.phaseErrors[phaseName].push({
      message: error.message,
      timestamp: Date.now(),
      stack: error.stack
    });
  }

  /**
   * Get current startup status
   * @returns {Object} Status info
   */
  getStatus() {
    return {
      currentPhase: this.currentPhase,
      completedPhases: [...this.completedPhases],
      totalDuration: this.startTime ? Date.now() - this.startTime : null,
      phaseTimings: this.phaseTimings,
      isReady: this.completedPhases.includes('ready'),
      errors: this.phaseErrors
    };
  }

  /**
   * Check if startup is complete
   * @returns {boolean} True if all phases completed
   */
  isStartupComplete() {
    return this.completedPhases.length === this.phases.length && !this.currentPhase;
  }

  /**
   * Get timing statistics for completed phases
   * @returns {Object} Timing stats
   */
  getTimingStats() {
    const stats = {};
    for (const phase of this.completedPhases) {
      const timing = this.phaseTimings[phase];
      stats[phase] = {
        start: timing.start,
        end: timing.end,
        duration: timing.duration
      };
    }
    return stats;
  }
}

/**
 * Validates startup prerequisites before phase transitions
 * Checks dependencies and readiness conditions
 */
class StartupValidator {
  constructor() {
    this.prerequisites = {};
    this.validationHistory = [];
  }

  /**
   * Define prerequisites for a phase
   * @param {string} phaseName - Target phase
   * @param {Object} conditions - Validation conditions
   */
  definePrerequisites(phaseName, conditions) {
    if (!conditions || typeof conditions !== 'object') {
      throw new Error('Conditions must be an object');
    }
    this.prerequisites[phaseName] = conditions;
  }

  /**
   * Validate phase prerequisites
   * @param {string} phaseName - Phase to validate
   * @param {Object} context - Current application context
   * @returns {Object} Validation result
   */
  validatePhasePrerequisites(phaseName, context) {
    if (!this.prerequisites[phaseName]) {
      return {
        valid: true,
        phase: phaseName,
        checks: [],
        failureReasons: []
      };
    }

    const checks = this.prerequisites[phaseName];
    const results = {
      valid: true,
      phase: phaseName,
      checks: [],
      failureReasons: [],
      timestamp: Date.now()
    };

    for (const [checkName, validator] of Object.entries(checks)) {
      try {
        const checkResult = typeof validator === 'function'
          ? validator(context)
          : validator === true;

        if (!checkResult) {
          results.valid = false;
          results.failureReasons.push(`Failed: ${checkName}`);
        }

        results.checks.push({
          name: checkName,
          passed: checkResult
        });
      } catch (error) {
        results.valid = false;
        results.failureReasons.push(`Check error ${checkName}: ${error.message}`);
        results.checks.push({
          name: checkName,
          passed: false,
          error: error.message
        });
      }
    }

    this.validationHistory.push(results);
    return results;
  }

  /**
   * Get validation history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.validationHistory];
  }

  /**
   * Clear validation history (keep recent entries)
   * @param {number} keepCount - Number of recent entries to keep
   */
  pruneHistory(keepCount = 100) {
    if (this.validationHistory.length > keepCount) {
      this.validationHistory = this.validationHistory.slice(-keepCount);
    }
  }
}

/**
 * Implements automatic recovery strategies for startup failures
 * Identifies failure types and applies recovery actions
 */
class StartupRecovery {
  constructor() {
    this.recoveryStrategies = {};
    this.recoveryHistory = [];
  }

  /**
   * Define recovery strategy for failure type
   * @param {string} failureType - Type of failure
   * @param {Object} strategy - Recovery strategy
   */
  defineRecoveryStrategy(failureType, strategy) {
    if (!strategy || typeof strategy !== 'object') {
      throw new Error('Strategy must be an object');
    }
    if (strategy.condition === undefined) {
      throw new Error('Strategy must have condition');
    }
    // actions defaults to empty array if not provided
    if (!strategy.actions) {
      strategy.actions = [];
    }
    this.recoveryStrategies[failureType] = strategy;
  }

  /**
   * Attempt recovery for failure
   * @param {string} failureType - Type of failure
   * @param {Object} context - Current context
   * @returns {Object} Recovery result
   */
  async attemptRecovery(failureType, context) {
    const strategy = this.recoveryStrategies[failureType];

    const result = {
      failureType,
      recovered: false,
      actions: [],
      timestamp: Date.now()
    };

    if (!strategy) {
      result.reason = `No recovery strategy for ${failureType}`;
      this.recoveryHistory.push(result);
      return result;
    }

    try {
      const conditionMet = typeof strategy.condition === 'function'
        ? strategy.condition(context)
        : strategy.condition === true;

      if (!conditionMet) {
        result.reason = 'Recovery condition not met';
        this.recoveryHistory.push(result);
        return result;
      }

      for (const action of strategy.actions) {
        try {
          if (typeof action === 'function') {
            await action(context);
          }
          result.actions.push({ action: action.name || 'function', success: true });
        } catch (error) {
          result.actions.push({ action: action.name || 'function', success: false, error: error.message });
        }
      }

      result.recovered = result.actions.every(a => a.success);
    } catch (error) {
      result.reason = error.message;
    }

    this.recoveryHistory.push(result);
    return result;
  }

  /**
   * Get recovery history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.recoveryHistory];
  }

  /**
   * Check if recovery succeeded
   * @returns {boolean} True if last recovery succeeded
   */
  wasLastRecoverySuccessful() {
    return this.recoveryHistory.length > 0
      && this.recoveryHistory[this.recoveryHistory.length - 1].recovered;
  }
}

/**
 * Orchestrates complete application startup process
 * Combines sequence management, validation, and recovery
 */
class InitializationOrchestrator {
  constructor() {
    this.sequenceManager = new StartupSequenceManager();
    this.validator = new StartupValidator();
    this.recovery = new StartupRecovery();
    this.executionContext = {};
    this.startupId = null;
  }

  /**
   * Execute complete startup process
   * @param {Array} phases - Array of phase definitions with name, validate, execute
   * @returns {Object} Startup result
   */
  async executeStartup(phases) {
    if (!Array.isArray(phases) || phases.length === 0) {
      throw new Error('Phases must be a non-empty array');
    }

    this.startupId = crypto.randomBytes(8).toString('hex');

    const result = {
      startupId: this.startupId,
      success: false,
      phases: [],
      errors: [],
      totalDuration: 0
    };

    try {
      for (const phaseConfig of phases) {
        const { name: phaseName, validate, execute } = phaseConfig;

        // Validate prerequisites
        if (validate) {
          const validationResult = this.validator.validatePhasePrerequisites(phaseName, this.executionContext);
          if (!validationResult.valid) {
            const failureMsg = `${phaseName} validation failed: ${validationResult.failureReasons.join(', ')}`;
            result.errors.push(failureMsg);

            // Attempt recovery
            const recoveryResult = await this.recovery.attemptRecovery(
              `${phaseName}_validation_failure`,
              this.executionContext
            );

            if (!recoveryResult.recovered) {
              throw new Error(failureMsg);
            }
          }
        }

        // Start phase
        this.sequenceManager.startPhase(phaseName);

        // Execute phase
        let phaseResult;
        try {
          if (typeof execute === 'function') {
            phaseResult = await execute(this.executionContext);
          } else {
            phaseResult = null;
          }
        } catch (phaseError) {
          this.sequenceManager.recordPhaseError(phaseName, phaseError);

          // Attempt recovery
          const recoveryResult = await this.recovery.attemptRecovery(
            `${phaseName}_execution_failure`,
            this.executionContext
          );

          if (!recoveryResult.recovered) {
            throw phaseError;
          }
        }

        // Complete phase
        this.sequenceManager.completePhase(phaseResult);

        // Update context
        if (phaseResult && typeof phaseResult === 'object') {
          this.executionContext = { ...this.executionContext, ...phaseResult };
        }

        result.phases.push({
          name: phaseName,
          success: true,
          result: phaseResult
        });
      }

      result.success = this.sequenceManager.isStartupComplete();
      result.totalDuration = Date.now() - this.sequenceManager.startTime;
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Get complete startup state
   * @returns {Object} Comprehensive startup state
   */
  getStartupState() {
    return {
      startupId: this.startupId,
      sequenceStatus: this.sequenceManager.getStatus(),
      timingStats: this.sequenceManager.getTimingStats(),
      validationHistory: this.validator.getHistory(),
      recoveryHistory: this.recovery.getHistory(),
      executionContext: this.executionContext,
      isReady: this.sequenceManager.isStartupComplete()
    };
  }

  /**
   * Reset startup state
   */
  reset() {
    this.sequenceManager = new StartupSequenceManager();
    this.executionContext = {};
    this.startupId = null;
  }

  /**
   * Get startup readiness
   * @returns {boolean} True if startup complete and ready
   */
  isReady() {
    return this.sequenceManager.isStartupComplete();
  }
}

module.exports = {
  StartupSequenceManager,
  StartupValidator,
  StartupRecovery,
  InitializationOrchestrator
};
