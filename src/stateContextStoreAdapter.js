/**
 * State Context Store Adapter
 *
 * Defines the interface for storing and retrieving State Context V2 across
 * multiple backends (memory, Redis, TableStore, etc.). Default: memory.
 */

const crypto = require('node:crypto');

/**
 * Abstract Store Adapter - defines the interface
 */
class StoreAdapter {
  /**
   * Store a context for the given correlationId
   * @param {string} correlationId - Context correlation ID
   * @param {Object} context - ExecutionContract.toJSON()
   * @param {number} ttlMs - TTL in milliseconds (default 900000)
   * @returns {Promise<void>}
   */
  async set(correlationId, context, ttlMs = 900000) {
    throw new Error('set() must be implemented by subclass');
  }

  /**
   * Retrieve a context by correlationId
   * @param {string} correlationId
   * @returns {Promise<Object|null>} Context or null if not found/expired
   */
  async get(correlationId) {
    throw new Error('get() must be implemented by subclass');
  }

  /**
   * Delete a context by correlationId
   * @param {string} correlationId
   * @returns {Promise<boolean>} true if deleted, false if not found
   */
  async delete(correlationId) {
    throw new Error('delete() must be implemented by subclass');
  }

  /**
   * List all non-expired contexts
   * @returns {Promise<Array>} Array of { correlationId, context, expiresAt }
   */
  async list() {
    throw new Error('list() must be implemented by subclass');
  }

  /**
   * Clear all contexts
   * @returns {Promise<number>} Number of contexts cleared
   */
  async clear() {
    throw new Error('clear() must be implemented by subclass');
  }

  /**
   * Get store statistics
   * @returns {Promise<Object>} { count, ttlMs, avgSize, ... }
   */
  async stats() {
    throw new Error('stats() must be implemented by subclass');
  }

  /**
   * Perform cleanup of expired entries (backend-specific)
   * @returns {Promise<number>} Number of entries cleaned
   */
  async cleanup() {
    throw new Error('cleanup() must be implemented by subclass');
  }
}

/**
 * In-Memory Store Adapter (Default)
 *
 * Suitable for single-instance deployments and testing.
 * Uses Map for O(1) lookup.
 *
 * IMPORTANT: In clustered deployments, a shared store (Redis/TableStore)
 * is required for safe context propagation across instances.
 */
class MemoryStoreAdapter extends StoreAdapter {
  constructor({ maxEntries = 10000 } = {}) {
    super();
    this.records = new Map();
    this.maxEntries = maxEntries;
    this.cleanupInterval = null;
  }

  /**
   * Initialize cleanup interval (optional, for automatic expiration)
   * @param {number} intervalMs - Cleanup interval in milliseconds (default 60000)
   */
  startCleanup(intervalMs = 60000) {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(async () => {
      await this.cleanup();
    }, intervalMs);
    // Allow process to exit even if interval is running
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop cleanup interval
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async set(correlationId, context, ttlMs = 900000) {
    if (!correlationId || typeof correlationId !== 'string') {
      throw new Error('correlationId must be non-empty string');
    }
    if (!context || typeof context !== 'object') {
      throw new Error('context must be an object');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('ttlMs must be positive number');
    }

    // Check capacity before adding
    if (this.records.size >= this.maxEntries && !this.records.has(correlationId)) {
      throw new Error(`Store capacity exceeded (max ${this.maxEntries} entries)`);
    }

    const expiresAt = Date.now() + ttlMs;
    this.records.set(correlationId, {
      context: JSON.parse(JSON.stringify(context)), // Deep copy
      expiresAt,
      createdAt: Date.now()
    });
  }

  async get(correlationId) {
    if (!correlationId || typeof correlationId !== 'string') {
      return null;
    }

    const record = this.records.get(correlationId);
    if (!record) {
      return null;
    }

    // Check expiration
    if (Date.now() >= record.expiresAt) {
      this.records.delete(correlationId);
      return null;
    }

    return JSON.parse(JSON.stringify(record.context));
  }

  async delete(correlationId) {
    return this.records.delete(correlationId);
  }

  async list() {
    const now = Date.now();
    const results = [];

    for (const [correlationId, record] of this.records) {
      if (now < record.expiresAt) {
        results.push({
          correlationId,
          context: JSON.parse(JSON.stringify(record.context)),
          expiresAt: new Date(record.expiresAt).toISOString()
        });
      }
    }

    return results;
  }

  async clear() {
    const count = this.records.size;
    this.records.clear();
    return count;
  }

  async stats() {
    const now = Date.now();
    let totalSize = 0;
    let validCount = 0;

    for (const [, record] of this.records) {
      if (now < record.expiresAt) {
        validCount++;
        totalSize += JSON.stringify(record.context).length;
      }
    }

    return {
      backend: 'memory',
      totalEntries: this.records.size,
      validEntries: validCount,
      expiredEntries: this.records.size - validCount,
      maxEntries: this.maxEntries,
      totalSizeBytes: totalSize,
      avgSizeBytes: validCount > 0 ? Math.round(totalSize / validCount) : 0
    };
  }

  async cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [correlationId, record] of this.records) {
      if (now >= record.expiresAt) {
        this.records.delete(correlationId);
        cleaned++;
      }
    }

    return cleaned;
  }
}

/**
 * Create a store adapter from configuration
 * @param {Object} config - { backend: 'memory' | 'redis' | ... , options: {...} }
 * @returns {StoreAdapter}
 */
function createStoreAdapter(config = {}) {
  const backend = (config.backend || 'memory').toLowerCase();

  switch (backend) {
    case 'memory':
      return new MemoryStoreAdapter(config.options);
    case 'redis':
      // TODO: Implement RedisStoreAdapter
      throw new Error('Redis adapter not yet implemented');
    case 'tablestore':
      // TODO: Implement TableStoreAdapter
      throw new Error('TableStore adapter not yet implemented');
    default:
      throw new Error(`Unknown store backend: ${backend}`);
  }
}

module.exports = {
  StoreAdapter,
  MemoryStoreAdapter,
  createStoreAdapter
};
