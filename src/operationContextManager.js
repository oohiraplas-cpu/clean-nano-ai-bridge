/**
 * Operation Context Manager
 *
 * Manages operation execution context with:
 * - Context creation and lifecycle management
 * - Distributed tracing with correlation IDs
 * - Context propagation across system boundaries
 * - Context validation and integrity verification
 * - Operation metadata and audit trail
 *
 * Ensures complete traceability of distributed operations
 * across Claude Code, Power Apps, and Bridge components.
 */

const crypto = require('crypto');

/**
 * Represents a single operation context
 * Tracks metadata, trace chain, and lifecycle
 */
class OperationContext {
  constructor(operationId, userId, operationType, metadata = {}) {
    if (!operationId || typeof operationId !== 'string') {
      throw new Error('operationId must be non-empty string');
    }
    if (!userId || typeof userId !== 'string') {
      throw new Error('userId must be non-empty string');
    }
    if (!operationType || typeof operationType !== 'string') {
      throw new Error('operationType must be non-empty string');
    }

    this.operationId = operationId;
    this.correlationId = crypto.randomUUID();
    this.userId = userId;
    this.operationType = operationType;
    this.metadata = metadata;

    // Timing
    this.startTime = Date.now();
    this.endTime = null;
    this.duration = null;

    // Tracing
    this.parentOperationId = null;
    this.traceChain = [this.operationId];
    this.steps = [];

    // Status
    this.status = 'active';
    this.result = null;
    this.error = null;

    // TTL management
    this.ttlSeconds = 3600; // 1 hour default
    this.expiresAt = this.startTime + (this.ttlSeconds * 1000);
  }

  /**
   * Record step in operation
   * @param {string} stepName - Name of step
   * @param {Object} data - Step data
   */
  recordStep(stepName, data = {}) {
    if (this.status !== 'active') {
      throw new Error('Cannot record step: operation not active');
    }

    this.steps.push({
      name: stepName,
      timestamp: Date.now(),
      data,
      sequenceNumber: this.steps.length
    });
  }

  /**
   * Set parent operation (for child operations)
   * @param {string} parentId - Parent operation ID
   * @param {Array} parentTraceChain - Parent trace chain
   */
  setParentOperation(parentId, parentTraceChain = []) {
    this.parentOperationId = parentId;
    this.traceChain = [...parentTraceChain, this.operationId];
  }

  /**
   * Complete operation with result
   * @param {Object} result - Operation result
   */
  complete(result) {
    if (this.status !== 'active') {
      throw new Error('Operation already completed');
    }

    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    this.status = 'completed';
    this.result = result;
  }

  /**
   * Fail operation with error
   * @param {Error} error - Error object
   */
  fail(error) {
    if (this.status !== 'active') {
      throw new Error('Operation already completed');
    }

    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
    this.status = 'failed';
    this.error = {
      message: error.message,
      code: error.code || 'UNKNOWN_ERROR',
      stack: error.stack
    };
  }

  /**
   * Check if context is expired
   * @returns {boolean} True if TTL exceeded
   */
  isExpired() {
    return Date.now() > this.expiresAt;
  }

  /**
   * Generate context hash for integrity verification
   * @returns {string} SHA256 hash
   */
  generateHash() {
    const data = JSON.stringify({
      operationId: this.operationId,
      correlationId: this.correlationId,
      userId: this.userId,
      operationType: this.operationType,
      status: this.status,
      traceChain: this.traceChain,
      startTime: this.startTime
    });

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Export context for propagation
   * @returns {Object} Serializable context
   */
  exportContext() {
    return {
      operationId: this.operationId,
      correlationId: this.correlationId,
      userId: this.userId,
      operationType: this.operationType,
      traceChain: [...this.traceChain],
      parentOperationId: this.parentOperationId,
      startTime: this.startTime,
      ttlSeconds: this.ttlSeconds,
      contextHash: this.generateHash()
    };
  }

  /**
   * Get context summary for logging
   * @returns {Object} Summary info
   */
  getSummary() {
    return {
      operationId: this.operationId,
      correlationId: this.correlationId,
      status: this.status,
      duration: this.duration,
      stepCount: this.steps.length,
      traceDepth: this.traceChain.length,
      hasError: !!this.error
    };
  }
}

/**
 * Injects context into system boundaries
 * Adds context to HTTP headers, MCP calls, etc.
 */
class ContextInjector {
  /**
   * Inject context into HTTP request headers
   * @param {Object} headers - Request headers object
   * @param {OperationContext} context - Context to inject
   * @returns {Object} Modified headers
   */
  static injectIntoHttpHeaders(headers, context) {
    if (!context || !(context instanceof OperationContext)) {
      throw new Error('Invalid context object');
    }

    return {
      ...headers,
      'X-Operation-Id': context.operationId,
      'X-Correlation-Id': context.correlationId,
      'X-User-Id': context.userId,
      'X-Operation-Type': context.operationType,
      'X-Trace-Chain': JSON.stringify(context.traceChain),
      'X-Context-Hash': context.generateHash()
    };
  }

  /**
   * Extract context from HTTP headers
   * @param {Object} headers - Request headers
   * @returns {Object|null} Extracted context data or null
   */
  static extractFromHttpHeaders(headers) {
    if (!headers['x-operation-id'] || !headers['x-correlation-id']) {
      return null;
    }

    return {
      operationId: headers['x-operation-id'],
      correlationId: headers['x-correlation-id'],
      userId: headers['x-user-id'],
      operationType: headers['x-operation-type'],
      traceChain: headers['x-trace-chain'] ? JSON.parse(headers['x-trace-chain']) : [],
      contextHash: headers['x-context-hash']
    };
  }

  /**
   * Inject context into MCP request body
   * @param {Object} body - MCP request body
   * @param {OperationContext} context - Context to inject
   * @returns {Object} Modified body
   */
  static injectIntoMcpBody(body, context) {
    if (!context || !(context instanceof OperationContext)) {
      throw new Error('Invalid context object');
    }

    return {
      ...body,
      _context: context.exportContext()
    };
  }

  /**
   * Inject context into function call arguments
   * @param {Array} args - Function arguments
   * @param {OperationContext} context - Context to inject
   * @returns {Array} Modified arguments with context as first element
   */
  static injectIntoFunctionCall(args, context) {
    if (!context || !(context instanceof OperationContext)) {
      throw new Error('Invalid context object');
    }

    return [context, ...args];
  }
}

/**
 * Validates context integrity and consistency
 * Detects tampering and expired contexts
 */
class ContextValidator {
  /**
   * Validate context integrity
   * @param {OperationContext} context - Context to validate
   * @returns {Object} Validation result
   */
  static validateIntegrity(context) {
    const result = {
      valid: true,
      checks: [],
      issues: []
    };

    // Check context existence
    if (!context) {
      result.valid = false;
      result.issues.push('Context is null or undefined');
      return result;
    }

    // Check required fields
    const requiredFields = ['operationId', 'correlationId', 'userId', 'status'];
    for (const field of requiredFields) {
      if (!context[field]) {
        result.valid = false;
        result.issues.push(`Missing required field: ${field}`);
      }
      result.checks.push({ field, present: !!context[field] });
    }

    return result;
  }

  /**
   * Validate context hash
   * @param {OperationContext} context - Context to validate
   * @param {string} expectedHash - Expected hash value
   * @returns {Object} Validation result
   */
  static validateHash(context, expectedHash) {
    const result = {
      valid: false,
      currentHash: context.generateHash(),
      expectedHash: expectedHash,
      matches: false
    };

    // Use timing-safe comparison
    try {
      result.matches = crypto.timingSafeEqual(
        Buffer.from(result.currentHash),
        Buffer.from(expectedHash)
      );
      result.valid = result.matches;
    } catch (error) {
      result.valid = false;
      result.error = error.message;
    }

    return result;
  }

  /**
   * Validate trace chain continuity
   * @param {Array} traceChain - Trace chain to validate
   * @param {string} expectedParentId - Expected parent ID
   * @returns {Object} Validation result
   */
  static validateTraceChain(traceChain, expectedParentId = null) {
    const result = {
      valid: true,
      length: traceChain.length,
      issues: []
    };

    if (!Array.isArray(traceChain) || traceChain.length === 0) {
      result.valid = false;
      result.issues.push('Trace chain is empty or not an array');
      return result;
    }

    // Check for duplicates
    const uniqueIds = new Set(traceChain);
    if (uniqueIds.size !== traceChain.length) {
      result.valid = false;
      result.issues.push('Trace chain contains duplicate IDs');
    }

    // Validate parent if expected
    if (expectedParentId && traceChain.length > 1) {
      const parentId = traceChain[traceChain.length - 2];
      if (parentId !== expectedParentId) {
        result.valid = false;
        result.issues.push(`Expected parent ${expectedParentId}, got ${parentId}`);
      }
    }

    return result;
  }

  /**
   * Validate context expiration
   * @param {OperationContext} context - Context to validate
   * @returns {Object} Validation result
   */
  static validateExpiration(context) {
    const result = {
      valid: !context.isExpired(),
      expiresAt: context.expiresAt,
      now: Date.now(),
      remainingSeconds: Math.floor((context.expiresAt - Date.now()) / 1000)
    };

    return result;
  }
}

/**
 * Propagates context across multi-step operations
 * Manages context lifecycle in distributed scenarios
 */
class ContextPropagator {
  constructor() {
    this.activeContexts = new Map();
    this.contextHistory = [];
    this.maxHistorySize = 1000;
  }

  /**
   * Create root operation context
   * @param {string} userId - User ID
   * @param {string} operationType - Operation type
   * @param {Object} metadata - Optional metadata
   * @returns {OperationContext} New context
   */
  createRootContext(userId, operationType, metadata = {}) {
    const operationId = crypto.randomUUID();
    const context = new OperationContext(operationId, userId, operationType, metadata);

    this.activeContexts.set(operationId, context);
    return context;
  }

  /**
   * Create child context for nested operation
   * @param {OperationContext} parentContext - Parent context
   * @param {string} operationType - Child operation type
   * @param {Object} metadata - Optional metadata
   * @returns {OperationContext} New child context
   */
  createChildContext(parentContext, operationType, metadata = {}) {
    if (!parentContext || !(parentContext instanceof OperationContext)) {
      throw new Error('Invalid parent context');
    }

    const operationId = crypto.randomUUID();
    const context = new OperationContext(
      operationId,
      parentContext.userId,
      operationType,
      metadata
    );

    context.setParentOperation(parentContext.operationId, parentContext.traceChain);
    context.correlationId = parentContext.correlationId; // Share correlation ID

    this.activeContexts.set(operationId, context);
    return context;
  }

  /**
   * Complete context and record in history
   * @param {OperationContext} context - Context to complete
   * @param {Object} result - Completion result
   */
  completeContext(context, result) {
    if (!context || !this.activeContexts.has(context.operationId)) {
      throw new Error('Context not found in active contexts');
    }

    context.complete(result);
    this.recordContextHistory(context);
    this.activeContexts.delete(context.operationId);
  }

  /**
   * Fail context and record in history
   * @param {OperationContext} context - Context to fail
   * @param {Error} error - Error that occurred
   */
  failContext(context, error) {
    if (!context || !this.activeContexts.has(context.operationId)) {
      throw new Error('Context not found in active contexts');
    }

    context.fail(error);
    this.recordContextHistory(context);
    this.activeContexts.delete(context.operationId);
  }

  /**
   * Record context in history
   * @param {OperationContext} context - Context to record
   */
  recordContextHistory(context) {
    this.contextHistory.push({
      operationId: context.operationId,
      correlationId: context.correlationId,
      status: context.status,
      duration: context.duration,
      timestamp: Date.now()
    });

    // Maintain size limit
    if (this.contextHistory.length > this.maxHistorySize) {
      this.contextHistory = this.contextHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get active context
   * @param {string} operationId - Operation ID
   * @returns {OperationContext|null} Context or null
   */
  getActiveContext(operationId) {
    return this.activeContexts.get(operationId) || null;
  }

  /**
   * Get all active contexts
   * @returns {Array} Array of active contexts
   */
  getActiveContexts() {
    return Array.from(this.activeContexts.values());
  }

  /**
   * Get context history
   * @param {number} limit - Maximum entries to return
   * @returns {Array} History entries
   */
  getHistory(limit = 100) {
    return this.contextHistory.slice(-limit);
  }

  /**
   * Clean up expired contexts
   * @returns {number} Number of contexts removed
   */
  cleanupExpiredContexts() {
    let removedCount = 0;

    for (const [operationId, context] of this.activeContexts.entries()) {
      if (context.isExpired()) {
        this.activeContexts.delete(operationId);
        this.recordContextHistory(context);
        removedCount++;
      }
    }

    return removedCount;
  }

  /**
   * Get propagator statistics
   * @returns {Object} Stats
   */
  getStats() {
    return {
      activeContextCount: this.activeContexts.size,
      historySize: this.contextHistory.length,
      maxHistorySize: this.maxHistorySize
    };
  }

  /**
   * Clear all contexts (for testing)
   */
  clear() {
    this.activeContexts.clear();
    this.contextHistory = [];
  }
}

module.exports = {
  OperationContext,
  ContextInjector,
  ContextValidator,
  ContextPropagator
};
