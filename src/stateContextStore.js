/**
 * State Context Store for Bridge MCP
 *
 * Manages Environment ID, App ID, Branch, Source Origin, State, and Writable status
 * across the Bridge execution flow. Enables internal resolution without re-prompting
 * Copilot Studio for Environment ID.
 *
 * Reference: CLAUDE.md - Environment IDコンテキスト引継ぎ不良の修正
 */

const crypto = require('node:crypto');

/**
 * Standardized State Context structure
 * @typedef {Object} StateContext
 * @property {string} environmentId - Power Apps environment ID
 * @property {string} appId - Power Apps application ID
 * @property {string} branch - Current Git branch
 * @property {string} canonicalBranch - Authoritative Git branch (main)
 * @property {string} sourceOrigin - Source origin (github_canonical, hold, unavailable)
 * @property {string} state - State (ready, hold, unavailable)
 * @property {boolean} writable - Whether writes are allowed
 * @property {string} [sha] - Git commit SHA
 * @property {string} [correlationId] - Unique request correlation ID (UUID)
 * @property {number} [timestamp] - Creation timestamp (ms)
 * @property {number} [expiresAt] - Expiration timestamp (ms, default: 15 minutes)
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

class StateContextStore {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this._store = new Map(); // key: correlationId, value: { context, expiresAt }
    this._ttl = ttlMs;
  }

  /**
   * Generate a new correlation ID for request tracking
   * @returns {string} UUID v4-like correlation ID
   */
  static generateCorrelationId() {
    return `ctx-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Create a new State Context from resolve_app_target result
   * @param {object} resolveResult - Result from resolve_app_target
   * @param {object} additionalFields - Additional fields (sha, correlationId, etc.)
   * @returns {StateContext}
   */
  static createFromResolveResult(resolveResult = {}, additionalFields = {}) {
    const data = resolveResult.data || {};
    const correlationId = additionalFields.correlationId || StateContextStore.generateCorrelationId();
    const now = Date.now();

    return {
      environmentId: data.environmentId || null,
      appId: data.appId || null,
      branch: data.gitBranch || null,
      canonicalBranch: data.gitBranch || null, // From resolve_app_target, this is always canonical
      sourceOrigin: data.sourceControl?.bridgeMirrorState === 'hold' ? 'hold' : (data.sourceOnCanonicalBranch ? 'github_canonical' : 'unavailable'),
      state: data.sourceControl?.bridgeMirrorState === 'hold' ? 'hold' : 'ready',
      writable: data.writesAllowed === true,
      sha: additionalFields.sha || null,
      correlationId,
      timestamp: now,
      expiresAt: now + (additionalFields.ttlMs || DEFAULT_TTL_MS)
    };
  }

  /**
   * Create a State Context from get_powerapps_state result
   * @param {object} stateResult - Result from get_powerapps_state
   * @param {object} sourceResult - Result from get_powerapps_source (for branch, sha, etc.)
   * @param {object} additionalFields - Additional fields
   * @returns {StateContext}
   */
  static createFromGetState(stateResult = {}, sourceResult = {}, additionalFields = {}) {
    const correlationId = additionalFields.correlationId || StateContextStore.generateCorrelationId();
    const now = Date.now();

    return {
      environmentId: stateResult.environmentId || additionalFields.environmentId || null,
      appId: stateResult.appId || additionalFields.appId || null,
      branch: sourceResult.branch || additionalFields.branch || null,
      canonicalBranch: sourceResult.canonicalBranch || additionalFields.canonicalBranch || null,
      sourceOrigin: sourceResult.sourceState || additionalFields.sourceOrigin || 'unavailable',
      state: sourceResult.sourceState === 'hold' ? 'hold' : 'ready',
      writable: sourceResult.writable === true,
      sha: sourceResult.sha || additionalFields.sha || null,
      correlationId,
      timestamp: now,
      expiresAt: now + (additionalFields.ttlMs || DEFAULT_TTL_MS)
    };
  }

  /**
   * Store a State Context
   * @param {StateContext} context
   * @returns {StateContext}
   */
  store(context) {
    if (!context || !context.correlationId) {
      throw new Error('StateContext must have a correlationId');
    }
    this._store.set(context.correlationId, {
      context,
      expiresAt: context.expiresAt || Date.now() + this._ttl
    });
    return context;
  }

  /**
   * Retrieve a State Context by correlation ID
   * @param {string} correlationId
   * @returns {StateContext|null}
   */
  get(correlationId) {
    if (!correlationId) return null;

    const entry = this._store.get(correlationId);
    if (!entry) return null;

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this._store.delete(correlationId);
      return null;
    }

    return entry.context;
  }

  /**
   * Validate a State Context is complete and valid
   * @param {StateContext} context
   * @returns {{ valid: boolean, errors: string[] }}
   */
  static validate(context) {
    const errors = [];

    if (!context || typeof context !== 'object') {
      return { valid: false, errors: ['State context is not an object'] };
    }

    // Required fields
    const required = ['environmentId', 'appId', 'branch', 'canonicalBranch', 'correlationId'];
    for (const field of required) {
      if (!context[field]) {
        errors.push(`${field}: missing or empty`);
      }
    }

    // Branch must match canonical
    if (context.branch && context.canonicalBranch && context.branch !== context.canonicalBranch) {
      errors.push(`branch mismatch: "${context.branch}" !== "${context.canonicalBranch}"`);
    }

    // State must be 'ready' for writes
    if (context.state && context.state !== 'ready') {
      errors.push(`state is not ready: ${context.state}`);
    }

    // Writable must be true for writes
    if (context.writable !== true) {
      errors.push('writable is not true');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Clear expired entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expiresAt) {
        this._store.delete(key);
      }
    }
  }

  /**
   * Clear all entries
   */
  clear() {
    this._store.clear();
  }

  /**
   * Get store size (for testing)
   */
  size() {
    return this._store.size;
  }
}

module.exports = {
  StateContextStore,
  DEFAULT_TTL_MS
};
