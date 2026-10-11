/**
 * Distributed Request Tracing & Context Propagation
 *
 * Provides complete request tracing across all Bridge components:
 * - Correlation ID generation and management
 * - Operation context lifecycle management
 * - Context propagation across sync/async boundaries
 * - Trace collection and performance metrics
 * - Fail-Closed enforcement point tracking
 *
 * Enables end-to-end request observability and debugging across distributed components.
 */

/**
 * Generates and manages correlation IDs for distributed tracing
 */
class CorrelationIDGenerator {
  constructor() {
    this.idFormat = 'corr-{timestamp}-{random}';
    this.generatedIds = [];
  }

  /**
   * Generate unique correlation ID
   * @returns {string} Correlation ID
   */
  generate() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    const id = `corr-${timestamp}-${random}`;

    this.generatedIds.push({
      id,
      generatedAt: timestamp
    });

    // Limit history
    if (this.generatedIds.length > 10000) {
      this.generatedIds = this.generatedIds.slice(-10000);
    }

    return id;
  }

  /**
   * Validate correlation ID format
   * @param {string} id - ID to validate
   * @returns {boolean} Valid format
   */
  isValid(id) {
    return typeof id === 'string' && id.startsWith('corr-') && id.split('-').length === 3;
  }

  /**
   * Get ID generation history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.generatedIds];
  }
}

/**
 * Manages operation context across request lifecycle
 */
class OperationContext {
  constructor(correlationId, userId, operationType, metadata = {}) {
    this.correlationId = correlationId;
    this.userId = userId;
    this.operationType = operationType;
    this.metadata = metadata;
    this.parentContextId = null;
    this.childContextIds = [];
    this.createdAt = Date.now();
    this.startTime = Date.now();
    this.endTime = null;
    this.duration = null;
    this.status = 'active';
    this.tracePoints = [];
    this.failClosedCheckpoints = [];
  }

  /**
   * Create child context
   * @param {string} childOperationType - Child operation type
   * @param {Object} childMetadata - Child metadata
   * @returns {OperationContext} Child context
   */
  createChild(childOperationType, childMetadata = {}) {
    const childContext = new OperationContext(
      this.correlationId,
      this.userId,
      childOperationType,
      childMetadata
    );
    childContext.parentContextId = this.correlationId;
    this.childContextIds.push(childContext.correlationId);
    return childContext;
  }

  /**
   * Record trace point
   * @param {string} component - Component name
   * @param {string} event - Event description
   * @param {Object} data - Event data
   */
  recordTracePoint(component, event, data = {}) {
    this.tracePoints.push({
      timestamp: Date.now(),
      component,
      event,
      data,
      relativeTime: Date.now() - this.startTime
    });
  }

  /**
   * Record Fail-Closed checkpoint
   * @param {string} checkpoint - Checkpoint name
   * @param {boolean} passed - Whether checkpoint passed
   * @param {string} reason - Failure reason if applicable
   */
  recordFailClosedCheckpoint(checkpoint, passed, reason = null) {
    this.failClosedCheckpoints.push({
      timestamp: Date.now(),
      checkpoint,
      passed,
      reason,
      relativeTime: Date.now() - this.startTime
    });
  }

  /**
   * Complete operation context
   * @param {string} finalStatus - Final status (success/failure/cancelled)
   */
  complete(finalStatus = 'success') {
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    this.status = finalStatus;
  }

  /**
   * Get context summary
   * @returns {Object} Summary data
   */
  getSummary() {
    return {
      correlationId: this.correlationId,
      userId: this.userId,
      operationType: this.operationType,
      status: this.status,
      duration: this.duration,
      createdAt: this.createdAt,
      tracePointCount: this.tracePoints.length,
      failClosedCheckpointCount: this.failClosedCheckpoints.length,
      hasFailedCheckpoints: this.failClosedCheckpoints.some(cp => !cp.passed)
    };
  }

  /**
   * Get full trace
   * @returns {Object} Complete trace data
   */
  getFullTrace() {
    return {
      context: this.getSummary(),
      tracePoints: this.tracePoints,
      failClosedCheckpoints: this.failClosedCheckpoints,
      metadata: this.metadata
    };
  }
}

/**
 * Propagates context across sync/async boundaries
 */
class ContextPropagator {
  constructor() {
    this.contextStack = [];
    this.propagationHistory = [];
  }

  /**
   * Push context to stack
   * @param {OperationContext} context - Context to push
   */
  pushContext(context) {
    this.contextStack.push(context);
    this.propagationHistory.push({
      action: 'push',
      timestamp: Date.now(),
      correlationId: context.correlationId,
      stackDepth: this.contextStack.length
    });
  }

  /**
   * Pop context from stack
   * @returns {OperationContext|null} Popped context
   */
  popContext() {
    const context = this.contextStack.pop();
    if (context) {
      this.propagationHistory.push({
        action: 'pop',
        timestamp: Date.now(),
        correlationId: context.correlationId,
        stackDepth: this.contextStack.length
      });
    }
    return context || null;
  }

  /**
   * Get current context
   * @returns {OperationContext|null} Current context
   */
  getCurrentContext() {
    return this.contextStack.length > 0 ? this.contextStack[this.contextStack.length - 1] : null;
  }

  /**
   * Execute function with context
   * @param {OperationContext} context - Context to use
   * @param {Function} fn - Function to execute
   * @returns {*} Function result
   */
  async executeWithContext(context, fn) {
    this.pushContext(context);
    try {
      const result = await fn(context);
      context.complete('success');
      return result;
    } catch (error) {
      context.complete('failure');
      context.recordTracePoint('error', 'Exception', { error: error.message });
      throw error;
    } finally {
      this.popContext();
    }
  }

  /**
   * Get propagation history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.propagationHistory];
  }

  /**
   * Get current stack depth
   * @returns {number} Stack depth
   */
  getStackDepth() {
    return this.contextStack.length;
  }
}

/**
 * Collects and aggregates trace data
 */
class TraceCollector {
  constructor() {
    this.traces = new Map();
    this.metrics = [];
    this.performanceStats = {};
  }

  /**
   * Record complete trace
   * @param {OperationContext} context - Context with trace data
   */
  recordTrace(context) {
    const summary = context.getSummary();
    this.traces.set(context.correlationId, {
      summary,
      fullTrace: context.getFullTrace(),
      recordedAt: Date.now()
    });

    // Record performance metrics
    this.metrics.push({
      correlationId: context.correlationId,
      operationType: context.operationType,
      duration: context.duration,
      tracePointCount: context.tracePoints.length,
      timestamp: Date.now()
    });

    // Update performance stats
    this.updatePerformanceStats(context.operationType, context.duration);

    // Limit storage
    if (this.traces.size > 5000) {
      const oldestId = Array.from(this.traces.keys())[0];
      this.traces.delete(oldestId);
    }

    if (this.metrics.length > 10000) {
      this.metrics = this.metrics.slice(-10000);
    }
  }

  /**
   * Update performance statistics
   * @param {string} operationType - Operation type
   * @param {number} duration - Duration in ms
   */
  updatePerformanceStats(operationType, duration) {
    if (!this.performanceStats[operationType]) {
      this.performanceStats[operationType] = {
        count: 0,
        totalDuration: 0,
        minDuration: duration,
        maxDuration: duration,
        avgDuration: 0
      };
    }

    const stats = this.performanceStats[operationType];
    stats.count++;
    stats.totalDuration += duration;
    stats.minDuration = Math.min(stats.minDuration, duration);
    stats.maxDuration = Math.max(stats.maxDuration, duration);
    stats.avgDuration = stats.totalDuration / stats.count;
  }

  /**
   * Get trace by correlation ID
   * @param {string} correlationId - Correlation ID
   * @returns {Object|null} Trace data or null
   */
  getTrace(correlationId) {
    return this.traces.get(correlationId) || null;
  }

  /**
   * Get performance statistics
   * @returns {Object} Performance stats
   */
  getPerformanceStats() {
    return { ...this.performanceStats };
  }

  /**
   * Get metrics summary
   * @returns {Object} Metrics summary
   */
  getMetricsSummary() {
    return {
      totalTraces: this.traces.size,
      totalMetrics: this.metrics.length,
      operationTypes: Object.keys(this.performanceStats),
      performanceStats: this.getPerformanceStats()
    };
  }

  /**
   * Query traces by operation type
   * @param {string} operationType - Operation type to filter
   * @returns {Array} Matching traces
   */
  queryTracesByOperation(operationType) {
    return Array.from(this.traces.values()).filter(trace =>
      trace.summary.operationType === operationType
    );
  }
}

/**
 * Tracks Fail-Closed enforcement checkpoints
 */
class FailClosedTracker {
  constructor() {
    this.checkpoints = [];
    this.violations = [];
    this.checkpointDefinitions = new Map();
  }

  /**
   * Define a Fail-Closed checkpoint
   * @param {string} name - Checkpoint name
   * @param {string} description - Description
   * @param {Function} validator - Validation function
   */
  defineCheckpoint(name, description, validator) {
    this.checkpointDefinitions.set(name, {
      name,
      description,
      validator,
      definedAt: Date.now()
    });
  }

  /**
   * Verify checkpoint
   * @param {string} checkpointName - Checkpoint name
   * @param {Object} context - Context to verify
   * @returns {Object} Verification result
   */
  verifyCheckpoint(checkpointName, context) {
    const checkpointDef = this.checkpointDefinitions.get(checkpointName);
    if (!checkpointDef) {
      throw new Error(`Checkpoint not defined: ${checkpointName}`);
    }

    const result = {
      checkpointName,
      correlationId: context.correlationId,
      timestamp: Date.now(),
      passed: false,
      reason: null
    };

    try {
      const validationResult = checkpointDef.validator(context);
      result.passed = validationResult.passed;
      result.reason = validationResult.reason;

      if (!result.passed) {
        this.violations.push({
          checkpoint: checkpointName,
          correlationId: context.correlationId,
          timestamp: Date.now(),
          reason: result.reason
        });
      }

      context.recordFailClosedCheckpoint(checkpointName, result.passed, result.reason);
    } catch (error) {
      result.passed = false;
      result.reason = `Checkpoint execution failed: ${error.message}`;
      this.violations.push({
        checkpoint: checkpointName,
        correlationId: context.correlationId,
        timestamp: Date.now(),
        reason: result.reason
      });
    }

    this.checkpoints.push(result);

    // Limit history
    if (this.checkpoints.length > 10000) {
      this.checkpoints = this.checkpoints.slice(-10000);
    }

    return result;
  }

  /**
   * Get all violations
   * @returns {Array} Violation records
   */
  getViolations() {
    return [...this.violations];
  }

  /**
   * Get checkpoint statistics
   * @returns {Object} Statistics
   */
  getStats() {
    const total = this.checkpoints.length;
    const passed = this.checkpoints.filter(cp => cp.passed).length;
    const failed = this.checkpoints.filter(cp => !cp.passed).length;

    return {
      total,
      passed,
      failed,
      passRate: total > 0 ? (passed / total * 100).toFixed(1) : 0,
      violations: this.violations.length
    };
  }

  /**
   * Get checkpoint history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.checkpoints];
  }
}

/**
 * Distributed tracing orchestrator
 */
class DistributedTracer {
  constructor() {
    this.idGenerator = new CorrelationIDGenerator();
    this.propagator = new ContextPropagator();
    this.traceCollector = new TraceCollector();
    this.failClosedTracker = new FailClosedTracker();
  }

  /**
   * Start new operation trace
   * @param {string} userId - User ID
   * @param {string} operationType - Operation type
   * @param {Object} metadata - Operation metadata
   * @returns {OperationContext} Created context
   */
  startTrace(userId, operationType, metadata = {}) {
    const correlationId = this.idGenerator.generate();
    const context = new OperationContext(correlationId, userId, operationType, metadata);
    this.propagator.pushContext(context);
    return context;
  }

  /**
   * End current trace
   * @param {string} finalStatus - Final status
   * @returns {Object} Trace summary
   */
  endTrace(finalStatus = 'success') {
    const context = this.propagator.popContext();
    if (!context) {
      throw new Error('No active context to end');
    }

    context.complete(finalStatus);
    this.traceCollector.recordTrace(context);

    return context.getSummary();
  }

  /**
   * Get current context
   * @returns {OperationContext|null} Current context
   */
  getCurrentContext() {
    return this.propagator.getCurrentContext();
  }

  /**
   * Execute operation with automatic tracing
   * @param {string} userId - User ID
   * @param {string} operationType - Operation type
   * @param {Function} operation - Operation to execute
   * @param {Object} metadata - Operation metadata
   * @returns {*} Operation result
   */
  async executeTracedOperation(userId, operationType, operation, metadata = {}) {
    const context = this.startTrace(userId, operationType, metadata);

    try {
      const result = await operation(context);
      this.endTrace('success');
      return result;
    } catch (error) {
      this.endTrace('failure');
      throw error;
    }
  }

  /**
   * Record trace point in current context
   * @param {string} component - Component name
   * @param {string} event - Event description
   * @param {Object} data - Event data
   */
  recordTracePoint(component, event, data = {}) {
    const context = this.getCurrentContext();
    if (context) {
      context.recordTracePoint(component, event, data);
    }
  }

  /**
   * Verify Fail-Closed checkpoint
   * @param {string} checkpointName - Checkpoint name
   * @returns {Object} Verification result
   */
  verifyCheckpoint(checkpointName) {
    const context = this.getCurrentContext();
    if (!context) {
      throw new Error('No active context for checkpoint verification');
    }

    return this.failClosedTracker.verifyCheckpoint(checkpointName, context);
  }

  /**
   * Get complete diagnostics
   * @returns {Object} Diagnostics data
   */
  getDiagnostics() {
    return {
      correlationIds: this.idGenerator.getHistory().length,
      activeContexts: this.propagator.getStackDepth(),
      traces: this.traceCollector.getMetricsSummary(),
      failClosed: this.failClosedTracker.getStats(),
      propagationHistory: this.propagator.getHistory().length
    };
  }
}

module.exports = {
  CorrelationIDGenerator,
  OperationContext,
  ContextPropagator,
  TraceCollector,
  FailClosedTracker,
  DistributedTracer
};
