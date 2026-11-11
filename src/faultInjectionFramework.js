/**
 * Fault Injection Framework: Controlled chaos testing
 *
 * Injects failures in controlled ways to test resilience:
 * - Network faults (latency, timeout, disconnection)
 * - Service faults (500, 503, degraded responses)
 * - Data faults (corruption, invalid state)
 * - Timing faults (race conditions, ordering)
 * - Resource faults (memory, CPU, disk)
 */

/**
 * Fault definition
 */
class Fault {
  constructor(id, type, target, trigger, effect, probability = 1.0) {
    this.id = id;
    this.type = type; // network, service, data, timing, resource
    this.target = target; // method/endpoint name
    this.trigger = trigger; // condition to trigger fault
    this.effect = effect; // what the fault does
    this.probability = probability; // 0-1, chance fault occurs
    this.enabled = true;
    this.hitCount = 0;
    this.createdAt = Date.now();
  }

  /**
   * Check if fault should trigger
   */
  shouldTrigger() {
    if (!this.enabled) return false;
    return Math.random() < this.probability;
  }

  /**
   * Record hit
   */
  recordHit() {
    this.hitCount++;
  }

  /**
   * Get info
   */
  getInfo() {
    return {
      id: this.id,
      type: this.type,
      target: this.target,
      enabled: this.enabled,
      hitCount: this.hitCount,
      uptime: Date.now() - this.createdAt
    };
  }
}

/**
 * Fault Injector: Manages and applies faults
 */
class FaultInjector {
  constructor(options = {}) {
    this.faults = new Map();
    this.scenarioMode = options.scenarioMode || false; // true = enabled, false = test-only
    this.logEnabled = options.logEnabled !== false;
    this.logs = [];
    this.maxLogs = options.maxLogs || 10000;
  }

  /**
   * Register a fault
   */
  registerFault(id, type, target, trigger, effect, probability = 1.0) {
    const fault = new Fault(id, type, target, trigger, effect, probability);
    this.faults.set(id, fault);
    this._log('fault_registered', { faultId: id, type, target });
    return fault;
  }

  /**
   * Enable/disable fault
   */
  setFaultEnabled(faultId, enabled) {
    const fault = this.faults.get(faultId);
    if (fault) {
      fault.enabled = enabled;
      this._log('fault_toggled', { faultId, enabled });
    }
  }

  /**
   * Set fault probability
   */
  setFaultProbability(faultId, probability) {
    const fault = this.faults.get(faultId);
    if (fault) {
      fault.probability = Math.max(0, Math.min(1, probability));
      this._log('fault_probability_changed', { faultId, probability: fault.probability });
    }
  }

  /**
   * Check for applicable fault
   */
  checkFault(method, operationType = null) {
    if (!this.scenarioMode) return null;

    for (const fault of this.faults.values()) {
      if (!fault.enabled) continue;

      // Check if target matches method or operation type
      const targetMatches = fault.target === method || fault.target === operationType;
      if (!targetMatches) continue;

      // Check trigger condition
      if (fault.trigger && typeof fault.trigger === 'function') {
        if (!fault.trigger()) continue;
      }

      // Check probability
      if (!fault.shouldTrigger()) continue;

      // Fault triggered!
      fault.recordHit();
      this._log('fault_triggered', {
        faultId: fault.id,
        type: fault.type,
        target: fault.target,
        effect: fault.effect
      });

      return fault;
    }

    return null;
  }

  /**
   * Apply fault effect
   */
  applyFault(fault, context = {}) {
    if (!fault || !fault.effect) return null;

    const effect = fault.effect;

    switch (effect.type) {
      case 'latency':
        // Simulate network latency
        return {
          delay: effect.delayMs || 1000,
          apply: async () => new Promise(resolve =>
            setTimeout(resolve, effect.delayMs || 1000)
          )
        };

      case 'timeout':
        // Simulate timeout
        return {
          throw: new Error(`Timeout: ${effect.message || 'Operation timed out'}`),
          apply: () => {
            throw new Error(`Timeout: ${effect.message || 'Operation timed out'}`);
          }
        };

      case 'error':
        // Simulate error response
        return {
          statusCode: effect.statusCode || 500,
          error: effect.message || 'Internal Server Error',
          apply: () => {
            const err = new Error(effect.message || 'Internal Server Error');
            err.statusCode = effect.statusCode || 500;
            throw err;
          }
        };

      case 'corruption':
        // Corrupt data
        return {
          corrupted: true,
          data: effect.corruptedData || null,
          apply: () => effect.corruptedData || null
        };

      case 'partial_response':
        // Return incomplete/degraded response
        return {
          partial: true,
          data: effect.partialData || {},
          apply: () => effect.partialData || {}
        };

      case 'memory_exhaustion':
        // Simulate memory exhaustion
        return {
          error: 'Out of memory',
          apply: () => {
            throw new Error('Out of memory');
          }
        };

      case 'race_condition':
        // Simulate race condition
        return {
          timing: effect.delayMs || 100,
          apply: async () => {
            const delays = [
              new Promise(resolve => setTimeout(resolve, effect.delayMs || 100)),
              new Promise(resolve => setTimeout(() => resolve('concurrent'), 50))
            ];
            return Promise.race(delays);
          }
        };

      default:
        return null;
    }
  }

  /**
   * Register fault scenario (multiple faults)
   */
  registerScenario(name, faults) {
    this._log('scenario_registered', { name, faultCount: faults.length });
    return {
      name,
      faults,
      enable: () => {
        faults.forEach(f => this.setFaultEnabled(f, true));
        this._log('scenario_enabled', { name });
      },
      disable: () => {
        faults.forEach(f => this.setFaultEnabled(f, false));
        this._log('scenario_disabled', { name });
      }
    };
  }

  /**
   * Get fault statistics
   */
  getStatistics() {
    const stats = {
      totalFaults: this.faults.size,
      enabledFaults: 0,
      totalHits: 0,
      faults: {}
    };

    for (const [id, fault] of this.faults) {
      if (fault.enabled) stats.enabledFaults++;
      stats.totalHits += fault.hitCount;
      stats.faults[id] = fault.getInfo();
    }

    return stats;
  }

  /**
   * Reset fault
   */
  resetFault(faultId) {
    const fault = this.faults.get(faultId);
    if (fault) {
      fault.hitCount = 0;
      this._log('fault_reset', { faultId });
    }
  }

  /**
   * Reset all faults
   */
  resetAll() {
    for (const fault of this.faults.values()) {
      fault.hitCount = 0;
    }
    this._log('all_faults_reset', {});
  }

  /**
   * Internal logging
   */
  _log(event, details = {}) {
    if (!this.logEnabled) return;

    const entry = {
      timestamp: Date.now(),
      event,
      details
    };

    this.logs.push(entry);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  /**
   * Get logs
   */
  getLogs(filter = {}) {
    let results = this.logs;

    if (filter.event) {
      results = results.filter(l => l.event === filter.event);
    }

    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Get fault by ID
   */
  getFault(faultId) {
    return this.faults.get(faultId);
  }

  /**
   * Get all faults
   */
  getAllFaults() {
    return Array.from(this.faults.values());
  }

  /**
   * Clear all faults
   */
  clearAll() {
    this.faults.clear();
    this.logs = [];
  }
}

/**
 * Chaos Scenario Builder
 */
class ChaosScenarioBuilder {
  constructor(injector) {
    this.injector = injector;
    this.scenarios = new Map();
  }

  /**
   * Build network partition scenario
   */
  networkPartition(name = 'network_partition') {
    const faultIds = [];

    // Register multiple related faults
    const fault1 = this.injector.registerFault(
      `${name}_timeout`,
      'network',
      'execute',
      () => true,
      { type: 'timeout', message: 'Network partition' },
      0.5
    );
    faultIds.push(fault1.id);

    const fault2 = this.injector.registerFault(
      `${name}_latency`,
      'network',
      'execute',
      () => true,
      { type: 'latency', delayMs: 30000 },
      0.5
    );
    faultIds.push(fault2.id);

    return this.injector.registerScenario(name, faultIds);
  }

  /**
   * Build cascading failure scenario
   */
  cascadingFailure(name = 'cascading_failure') {
    const faultIds = [];

    // First: delayed response
    this.injector.registerFault(
      `${name}_delay`,
      'service',
      'verify',
      () => true,
      { type: 'latency', delayMs: 5000 },
      1.0
    );

    // Then: partial response
    this.injector.registerFault(
      `${name}_partial`,
      'service',
      'commit',
      () => true,
      { type: 'partial_response', partialData: {} },
      0.8
    );

    // Finally: error
    this.injector.registerFault(
      `${name}_error`,
      'service',
      'audit',
      () => true,
      { type: 'error', statusCode: 503, message: 'Service Unavailable' },
      0.5
    );

    return this.injector.registerScenario(name, [`${name}_delay`, `${name}_partial`, `${name}_error`]);
  }

  /**
   * Build race condition scenario
   */
  raceCondition(name = 'race_condition') {
    const faultIds = [];

    this.injector.registerFault(
      `${name}_timing`,
      'timing',
      'execute',
      () => true,
      { type: 'race_condition', delayMs: 100 },
      1.0
    );

    return this.injector.registerScenario(name, [`${name}_timing`]);
  }

  /**
   * Build resource exhaustion scenario
   */
  resourceExhaustion(name = 'resource_exhaustion') {
    const faultIds = [];

    this.injector.registerFault(
      `${name}_memory`,
      'resource',
      'execute',
      () => true,
      { type: 'memory_exhaustion' },
      0.3
    );

    return this.injector.registerScenario(name, [`${name}_memory`]);
  }
}

module.exports = {
  Fault,
  FaultInjector,
  ChaosScenarioBuilder
};
