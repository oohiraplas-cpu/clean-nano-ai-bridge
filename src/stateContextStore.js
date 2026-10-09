/**
 * StateContextStore: In-Memory State Context Storage with TTL
 *
 * Stores and retrieves State Context objects with automatic expiration.
 * Implements the State Context persistence layer for stateContextComplete=true.
 *
 * Reference: PHASE 1 State Context自動引継ぎ完成
 * State Context形式:
 * {
 *   appId: "...",
 *   environmentId: "...",
 *   displayName: "...",
 *   branch: "...",
 *   canonicalBranch: "...",
 *   sha: "...",
 *   sourceOrigin: "...",
 *   state: "ready|hold|blocked",
 *   writable: true,
 *   correlationId: "...",
 *   createdAt: "ISO8601",
 *   expiresAt: "ISO8601"
 * }
 */

class StateContextStore {
  constructor(options = {}) {
    // TTL in milliseconds (default 15分)
    this.ttlMs = options.ttlMs || 900000;
    // In-memory store: Map<correlationId, stateContext>
    this.store = new Map();
    // Cleanup interval: remove expired entries every 60 seconds
    // unref() allows process to exit even if interval is active
    this.cleanupInterval = setInterval(() => this._cleanup(), 60000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Remove expired entries from store
   * @private
   */
  _cleanup() {
    const now = Date.now();
    for (const [correlationId, context] of this.store.entries()) {
      if (context.expiresAt && new Date(context.expiresAt).getTime() < now) {
        this.store.delete(correlationId);
      }
    }
  }

  /**
   * Check if context is expired
   * @private
   * @param {object} context
   * @returns {boolean}
   */
  _isExpired(context) {
    if (!context.expiresAt) return false;
    const now = Date.now();
    const expiryTime = new Date(context.expiresAt).getTime();
    return expiryTime < now;
  }

  /**
   * Save State Context with automatic TTL expiration
   * @param {object} context - Complete or partial State Context
   * @returns {object} Stored context with metadata
   */
  set(context) {
    if (!context || typeof context !== 'object') {
      throw new Error('State Context object required');
    }

    const correlationId = context.correlationId;
    if (!correlationId || typeof correlationId !== 'string' || correlationId.length < 8) {
      throw new Error('correlationId: non-empty string (minimum 8 characters) required');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    const stored = {
      ...context,
      createdAt: context.createdAt || now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      _stored: true,
      _ttlMs: this.ttlMs
    };

    this.store.set(correlationId, stored);
    return stored;
  }

  /**
   * Retrieve State Context by correlationId
   * @param {string} correlationId
   * @returns {object|null} State Context if valid and not expired, null otherwise
   */
  get(correlationId) {
    if (!correlationId) return null;

    const context = this.store.get(correlationId);
    if (!context) return null;

    // Check expiration
    if (this._isExpired(context)) {
      this.store.delete(correlationId);
      return null;
    }

    return context;
  }

  /**
   * List all valid (non-expired) State Contexts
   * @returns {array} Array of State Context objects
   */
  list() {
    const result = [];
    const now = Date.now();

    for (const [correlationId, context] of this.store.entries()) {
      if (this._isExpired(context)) {
        this.store.delete(correlationId);
      } else {
        result.push({ ...context });
      }
    }

    return result;
  }

  /**
   * Delete specific State Context
   * @param {string} correlationId
   * @returns {boolean} true if deleted, false if not found
   */
  delete(correlationId) {
    return this.store.delete(correlationId);
  }

  /**
   * Clear all State Contexts
   */
  clear() {
    this.store.clear();
  }

  /**
   * Get store statistics
   * @returns {object}
   */
  stats() {
    const total = this.store.size;
    let expired = 0;
    const now = Date.now();

    for (const context of this.store.values()) {
      if (context.expiresAt && new Date(context.expiresAt).getTime() < now) {
        expired++;
      }
    }

    return {
      total,
      valid: total - expired,
      expired,
      ttlMs: this.ttlMs
    };
  }

  /**
   * Shutdown: stop cleanup interval
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

module.exports = StateContextStore;
