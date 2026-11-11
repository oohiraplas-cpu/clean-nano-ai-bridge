/**
 * Security Hardening: Input Validation, Sanitization, Rate Limiting
 *
 * Implements defense-in-depth security controls:
 * - Input validation and sanitization
 * - Rate limiting per correlation ID
 * - SQL injection / command injection prevention
 * - XSS prevention for logs/audit
 * - SSRF protection
 * - Size limits on payloads
 */

const crypto = require('node:crypto');

/**
 * Input Sanitizer for preventing injection attacks
 */
class InputSanitizer {
  constructor() {
    // Patterns for dangerous content
    this.sqlInjectionPattern = /(\b(union|select|insert|update|delete|drop|create|alter)\b)|(-{2}|\/\*|\*\/|;)/gi;
    this.commandInjectionPattern = /[;&|`$\(\)\{\}\[\]<>\\]/g;
    this.xssPattern = /<script[^>]*>[\s\S]*?<\/script>|<iframe[^>]*>[\s\S]*?<\/iframe>|javascript:|on\w+\s*=/gi;
  }

  /**
   * Sanitize string input
   * @param {string} input - Input to sanitize
   * @param {string} context - Where the input comes from (sql, command, html, path)
   * @returns {object} { sanitized, issues }
   */
  sanitize(input, context = 'general') {
    if (typeof input !== 'string') {
      return { sanitized: input, issues: [] };
    }

    const issues = [];

    if (context === 'sql' && this.sqlInjectionPattern.test(input)) {
      issues.push('SQL injection pattern detected');
    }

    if (context === 'command' && this.commandInjectionPattern.test(input)) {
      issues.push('Command injection pattern detected');
    }

    if (context === 'html' && this.xssPattern.test(input)) {
      issues.push('XSS pattern detected');
    }

    // Always trim and check for null bytes
    const sanitized = input.trim().replace(/\0/g, '');

    if (sanitized.length !== input.length && !input.trim()) {
      issues.push('Contains null bytes or suspicious whitespace');
    }

    return { sanitized, issues };
  }

  /**
   * Validate and sanitize object recursively
   * @param {object} obj - Object to validate
   * @param {string} context - Validation context
   * @param {number} depth - Current depth
   * @returns {object} { valid, sanitized, issues }
   */
  validateObject(obj, context = 'general', depth = 0) {
    if (depth > 10) {
      return { valid: false, sanitized: null, issues: ['Object nesting too deep (>10)'] };
    }

    if (typeof obj !== 'object' || obj === null) {
      return { valid: true, sanitized: obj, issues: [] };
    }

    const issues = [];
    const sanitized = Array.isArray(obj) ? [] : {};

    for (const [key, value] of Object.entries(obj)) {
      // Validate key
      if (!/^[a-zA-Z0-9_\-\.]+$/.test(key)) {
        issues.push(`Invalid key name: ${key}`);
        continue;
      }

      if (typeof value === 'string') {
        const { sanitized: clean, issues: strIssues } = this.sanitize(value, context);
        sanitized[key] = clean;
        issues.push(...strIssues.map(i => `${key}: ${i}`));
      } else if (typeof value === 'object' && value !== null) {
        const result = this.validateObject(value, context, depth + 1);
        sanitized[key] = result.sanitized;
        issues.push(...result.issues);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        sanitized[key] = value;
      } else if (value === null || value === undefined) {
        sanitized[key] = value;
      }
    }

    return {
      valid: issues.length === 0,
      sanitized,
      issues: issues.length > 0 ? issues : null
    };
  }
}

/**
 * Rate Limiter: Prevent brute force and DoS
 */
class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000; // 1 minute default
    this.maxRequests = options.maxRequests || 100; // requests per window
    this.cleanupIntervalMs = options.cleanupIntervalMs || 300000; // 5 minutes
    this.store = new Map(); // correlationId -> { count, resetTime }

    // Periodic cleanup
    this.cleanupInterval = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    // Don't keep the process alive for cleanup
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Check if request is allowed
   * @param {string} key - Rate limit key (usually correlationId)
   * @returns {object} { allowed, remaining, resetTime }
   */
  isAllowed(key) {
    const now = Date.now();
    let entry = this.store.get(key);

    if (!entry || now > entry.resetTime) {
      // New window
      entry = {
        count: 1,
        resetTime: now + this.windowMs
      };
      this.store.set(key, entry);
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: entry.resetTime
      };
    }

    // Existing window
    if (entry.count < this.maxRequests) {
      entry.count++;
      return {
        allowed: true,
        remaining: this.maxRequests - entry.count,
        resetTime: entry.resetTime
      };
    }

    // Rate limit exceeded
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime
    };
  }

  /**
   * Cleanup old entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.resetTime + this.windowMs) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Reset for a key
   */
  reset(key) {
    this.store.delete(key);
  }

  /**
   * Destroy limiter
   */
  destroy() {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }

  /**
   * Get stats
   */
  getStats() {
    const now = Date.now();
    const entries = Array.from(this.store.entries());
    const active = entries.filter(([, entry]) => now <= entry.resetTime);

    return {
      totalKeys: this.store.size,
      activeKeys: active.length,
      entries: Object.fromEntries(active.map(([k, v]) => [k, {
        count: v.count,
        remaining: Math.max(0, this.maxRequests - v.count),
        resetTime: v.resetTime
      }]))
    };
  }
}

/**
 * Payload Size Validator
 */
class PayloadValidator {
  constructor(options = {}) {
    this.maxBodySize = options.maxBodySize || 1024 * 100; // 100KB default
    this.maxArrayLength = options.maxArrayLength || 1000;
    this.maxStringLength = options.maxStringLength || 10000;
  }

  /**
   * Validate request payload
   * @param {object} payload - Payload to validate
   * @returns {object} { valid, size, issues }
   */
  validate(payload) {
    const issues = [];
    const size = JSON.stringify(payload || {}).length;

    if (size > this.maxBodySize) {
      issues.push(`Payload too large: ${size} > ${this.maxBodySize} bytes`);
    }

    this._validateStructure(payload, issues);

    return {
      valid: issues.length === 0,
      size,
      issues: issues.length > 0 ? issues : null
    };
  }

  /**
   * Recursively validate structure
   */
  _validateStructure(obj, issues, path = '', depth = 0) {
    if (depth > 20) {
      issues.push(`Object nesting too deep at ${path}`);
      return;
    }

    if (Array.isArray(obj)) {
      if (obj.length > this.maxArrayLength) {
        issues.push(`Array too large at ${path}: ${obj.length} > ${this.maxArrayLength}`);
      }
      for (let i = 0; i < Math.min(obj.length, 100); i++) {
        this._validateStructure(obj[i], issues, `${path}[${i}]`, depth + 1);
      }
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [key, value] of Object.entries(obj)) {
        this._validateStructure(value, issues, `${path}.${key}`, depth + 1);
      }
    } else if (typeof obj === 'string' && obj.length > this.maxStringLength) {
      issues.push(`String too long at ${path}: ${obj.length} > ${this.maxStringLength}`);
    }
  }
}

/**
 * SSRF (Server-Side Request Forgery) Protection
 */
class SSRFProtection {
  constructor(options = {}) {
    this.allowedDomains = options.allowedDomains || [];
    this.blockedPatterns = options.blockedPatterns || [
      /^localhost/,
      /^127\./,
      /^192\.168\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^169\.254\./,
      /^metadata\.google\.internal/,
      /^169\.254\.169\.254/,
      /^aws\.internal/
    ];
  }

  /**
   * Validate URL for SSRF safety
   * @param {string} urlString - URL to validate
   * @returns {object} { safe, reason }
   */
  validateUrl(urlString) {
    try {
      const url = new URL(urlString);

      // Check blocked patterns
      for (const pattern of this.blockedPatterns) {
        if (pattern.test(url.hostname)) {
          return { safe: false, reason: 'Hostname matches blocked pattern' };
        }
      }

      // Check whitelist if provided
      if (this.allowedDomains.length > 0) {
        if (!this.allowedDomains.includes(url.hostname)) {
          return { safe: false, reason: 'Hostname not in whitelist' };
        }
      }

      // Check for dangerous protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { safe: false, reason: 'Dangerous protocol' };
      }

      return { safe: true };
    } catch (error) {
      return { safe: false, reason: 'Invalid URL' };
    }
  }
}

/**
 * Audit Logging for security events
 */
class SecurityAuditLog {
  constructor() {
    this.events = [];
    this.maxEvents = 10000;
  }

  /**
   * Log security event
   * @param {object} event - Event to log
   */
  log(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      type: event.type,
      severity: event.severity || 'info', // info, warning, critical
      correlationId: event.correlationId,
      principal: event.principal, // Who performed the action
      action: event.action,
      resource: event.resource,
      result: event.result, // allowed, denied
      reason: event.reason,
      details: event.details
    };

    this.events.push(entry);

    // Keep only recent events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  /**
   * Get recent security events
   */
  getEvents(filter = {}) {
    let results = this.events;

    if (filter.severity) {
      results = results.filter(e => e.severity === filter.severity);
    }

    if (filter.type) {
      results = results.filter(e => e.type === filter.type);
    }

    if (filter.result) {
      results = results.filter(e => e.result === filter.result);
    }

    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Get summary
   */
  getSummary() {
    const summary = {
      total: this.events.length,
      byType: {},
      bySeverity: { info: 0, warning: 0, critical: 0 },
      byResult: {}
    };

    for (const event of this.events) {
      summary.byType[event.type] = (summary.byType[event.type] || 0) + 1;
      summary.bySeverity[event.severity] = (summary.bySeverity[event.severity] || 0) + 1;
      summary.byResult[event.result] = (summary.byResult[event.result] || 0) + 1;
    }

    return summary;
  }

  /**
   * Clear events
   */
  clear() {
    this.events = [];
  }
}

module.exports = {
  InputSanitizer,
  RateLimiter,
  PayloadValidator,
  SSRFProtection,
  SecurityAuditLog
};
