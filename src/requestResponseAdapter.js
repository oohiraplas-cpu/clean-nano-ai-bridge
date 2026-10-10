/**
 * Request/Response Adapter
 *
 * Provides protocol-agnostic request/response handling with:
 * - Normalization of requests from HTTP, MCP, and other sources
 * - Response formatting for different protocol targets
 * - Unified request/response validation
 * - Automatic protocol detection and adaptation
 * - Request/response transformation pipelines
 *
 * Ensures seamless integration across HTTP REST, MCP, and internal APIs.
 */

/**
 * Normalizes requests from different sources into unified format
 * Handles HTTP, MCP, and raw object sources
 */
class RequestNormalizer {
  constructor() {
    this.supportedProtocols = ['http', 'mcp', 'raw'];
    this.normalizedCache = new Map();
    this.normalizationHistory = [];
  }

  /**
   * Auto-detect request protocol
   * @param {Object} request - Request object
   * @returns {string} Detected protocol
   */
  detectProtocol(request) {
    if (!request || typeof request !== 'object') {
      return null;
    }

    // Detect MCP: has method, not HTTP-like
    if (request.method && !request.body && !request.headers) {
      return 'mcp';
    }

    // Detect HTTP: has body/headers/url
    if (request.body || request.headers || request.url) {
      return 'http';
    }

    // Default to raw
    return 'raw';
  }

  /**
   * Normalize HTTP request
   * @param {Object} httpRequest - HTTP request
   * @returns {Object} Normalized request
   */
  normalizeHttpRequest(httpRequest) {
    if (!httpRequest || typeof httpRequest !== 'object') {
      throw new Error('Invalid HTTP request');
    }

    let body = httpRequest.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        // Keep as string if not valid JSON
      }
    }

    return {
      protocol: 'http',
      method: httpRequest.method || 'GET',
      path: httpRequest.url || httpRequest.path || '/',
      headers: httpRequest.headers || {},
      body: body || {},
      query: httpRequest.query || {},
      timestamp: httpRequest.timestamp || Date.now()
    };
  }

  /**
   * Normalize MCP request
   * @param {Object} mcpRequest - MCP request
   * @returns {Object} Normalized request
   */
  normalizeMcpRequest(mcpRequest) {
    if (!mcpRequest || typeof mcpRequest !== 'object') {
      throw new Error('Invalid MCP request');
    }

    return {
      protocol: 'mcp',
      method: mcpRequest.method || 'unknown',
      path: `/_mcp/${mcpRequest.method}`,
      headers: mcpRequest._headers || {},
      body: mcpRequest.params || {},
      query: {},
      timestamp: mcpRequest.timestamp || Date.now()
    };
  }

  /**
   * Normalize raw object request
   * @param {Object} rawRequest - Raw request object
   * @returns {Object} Normalized request
   */
  normalizeRawRequest(rawRequest) {
    if (!rawRequest || typeof rawRequest !== 'object') {
      throw new Error('Invalid raw request');
    }

    return {
      protocol: 'raw',
      method: rawRequest.method || rawRequest.operation || 'unknown',
      path: rawRequest.path || '/',
      headers: rawRequest.headers || {},
      body: rawRequest.body || rawRequest.params || {},
      query: rawRequest.query || {},
      timestamp: rawRequest.timestamp || Date.now()
    };
  }

  /**
   * Normalize request from any source
   * @param {Object} request - Request object
   * @param {string} protocolHint - Optional protocol hint
   * @returns {Object} Normalized request
   */
  normalize(request, protocolHint = null) {
    if (!request) {
      throw new Error('Request cannot be null or undefined');
    }

    const protocol = protocolHint || this.detectProtocol(request);

    let normalized;
    switch (protocol) {
      case 'http':
        normalized = this.normalizeHttpRequest(request);
        break;
      case 'mcp':
        normalized = this.normalizeMcpRequest(request);
        break;
      case 'raw':
        normalized = this.normalizeRawRequest(request);
        break;
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }

    // Add metadata
    normalized.originalProtocol = protocol;
    normalized.normalizedAt = Date.now();

    // Track in history
    this.normalizationHistory.push({
      protocol,
      timestamp: Date.now(),
      method: normalized.method
    });

    // Limit history size
    if (this.normalizationHistory.length > 1000) {
      this.normalizationHistory = this.normalizationHistory.slice(-1000);
    }

    return normalized;
  }

  /**
   * Get normalization history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.normalizationHistory];
  }
}

/**
 * Formats normalized responses for different protocol targets
 * Converts unified response format to protocol-specific responses
 */
class ResponseFormatter {
  constructor() {
    this.supportedFormats = ['http', 'mcp', 'raw'];
    this.formatHistory = [];
  }

  /**
   * Format response for HTTP
   * @param {Object} unifiedResponse - Unified response object
   * @returns {Object} HTTP response
   */
  formatHttpResponse(unifiedResponse) {
    if (!unifiedResponse) {
      throw new Error('Response cannot be null');
    }

    return {
      status: unifiedResponse.status || 200,
      statusCode: unifiedResponse.status || 200,
      headers: {
        'Content-Type': 'application/json',
        ...unifiedResponse.headers
      },
      body: {
        success: unifiedResponse.success,
        data: unifiedResponse.data,
        error: unifiedResponse.error,
        metadata: {
          operationId: unifiedResponse.operationId,
          correlationId: unifiedResponse.correlationId,
          timestamp: unifiedResponse.timestamp
        }
      }
    };
  }

  /**
   * Format response for MCP
   * @param {Object} unifiedResponse - Unified response object
   * @returns {Object} MCP response
   */
  formatMcpResponse(unifiedResponse) {
    if (!unifiedResponse) {
      throw new Error('Response cannot be null');
    }

    return {
      accepted: unifiedResponse.success,
      method: unifiedResponse.method,
      result: unifiedResponse.data,
      error: unifiedResponse.error ? {
        message: unifiedResponse.error.message,
        code: unifiedResponse.error.code
      } : null,
      _metadata: {
        operationId: unifiedResponse.operationId,
        correlationId: unifiedResponse.correlationId,
        executionTime: unifiedResponse.duration
      }
    };
  }

  /**
   * Format response for raw/internal API
   * @param {Object} unifiedResponse - Unified response object
   * @returns {Object} Raw response
   */
  formatRawResponse(unifiedResponse) {
    if (!unifiedResponse) {
      throw new Error('Response cannot be null');
    }

    return {
      success: unifiedResponse.success,
      status: unifiedResponse.status || (unifiedResponse.success ? 'ok' : 'error'),
      data: unifiedResponse.data,
      error: unifiedResponse.error,
      metadata: {
        operationId: unifiedResponse.operationId,
        correlationId: unifiedResponse.correlationId,
        timestamp: unifiedResponse.timestamp,
        duration: unifiedResponse.duration
      }
    };
  }

  /**
   * Format response for target protocol
   * @param {Object} unifiedResponse - Unified response
   * @param {string} targetProtocol - Target protocol
   * @returns {Object} Formatted response
   */
  format(unifiedResponse, targetProtocol) {
    if (!unifiedResponse || typeof unifiedResponse !== 'object') {
      throw new Error('Invalid response object');
    }

    let formatted;
    switch (targetProtocol) {
      case 'http':
        formatted = this.formatHttpResponse(unifiedResponse);
        break;
      case 'mcp':
        formatted = this.formatMcpResponse(unifiedResponse);
        break;
      case 'raw':
        formatted = this.formatRawResponse(unifiedResponse);
        break;
      default:
        throw new Error(`Unsupported format: ${targetProtocol}`);
    }

    // Track in history
    this.formatHistory.push({
      targetProtocol,
      timestamp: Date.now(),
      hasError: !!unifiedResponse.error
    });

    // Limit history
    if (this.formatHistory.length > 1000) {
      this.formatHistory = this.formatHistory.slice(-1000);
    }

    return formatted;
  }

  /**
   * Get format history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.formatHistory];
  }
}

/**
 * Validates requests and responses against schema/constraints
 */
class AdapterValidator {
  constructor() {
    this.requestRules = {};
    this.responseRules = {};
    this.validationHistory = [];
  }

  /**
   * Define validation rule for request
   * @param {string} method - Method name
   * @param {Object} rule - Validation rule
   */
  defineRequestRule(method, rule) {
    if (!rule || typeof rule !== 'object') {
      throw new Error('Rule must be an object');
    }
    this.requestRules[method] = rule;
  }

  /**
   * Define validation rule for response
   * @param {string} method - Method name
   * @param {Object} rule - Validation rule
   */
  defineResponseRule(method, rule) {
    if (!rule || typeof rule !== 'object') {
      throw new Error('Rule must be an object');
    }
    this.responseRules[method] = rule;
  }

  /**
   * Validate normalized request
   * @param {Object} normalizedRequest - Request to validate
   * @returns {Object} Validation result
   */
  validateRequest(normalizedRequest) {
    const result = {
      valid: true,
      method: normalizedRequest.method,
      checks: [],
      issues: []
    };

    // Check required fields
    const requiredFields = ['protocol', 'method', 'body'];
    for (const field of requiredFields) {
      const present = field in normalizedRequest;
      result.checks.push({ field, present });
      if (!present) {
        result.valid = false;
        result.issues.push(`Missing required field: ${field}`);
      }
    }

    // Apply method-specific rules
    const rule = this.requestRules[normalizedRequest.method];
    if (rule) {
      if (rule.requiredFields) {
        for (const field of rule.requiredFields) {
          if (!(field in normalizedRequest.body)) {
            result.valid = false;
            result.issues.push(`Missing required body field: ${field}`);
          }
        }
      }

      if (rule.validator && typeof rule.validator === 'function') {
        try {
          const validatorResult = rule.validator(normalizedRequest);
          if (!validatorResult) {
            result.valid = false;
            result.issues.push('Custom validation failed');
          }
        } catch (error) {
          result.valid = false;
          result.issues.push(`Validator error: ${error.message}`);
        }
      }
    }

    this.validationHistory.push({
      type: 'request',
      valid: result.valid,
      method: normalizedRequest.method,
      timestamp: Date.now()
    });

    return result;
  }

  /**
   * Validate formatted response
   * @param {Object} response - Response to validate
   * @param {string} method - Method that generated response
   * @returns {Object} Validation result
   */
  validateResponse(response, method) {
    const result = {
      valid: true,
      method,
      checks: [],
      issues: []
    };

    // Check response structure
    const requiredFields = ['success', 'data', 'error'];
    for (const field of requiredFields) {
      const present = field in response;
      result.checks.push({ field, present });
    }

    // Apply method-specific rules
    const rule = this.responseRules[method];
    if (rule) {
      if (rule.requireData && !response.data) {
        result.valid = false;
        result.issues.push('Response must contain data');
      }

      if (rule.validator && typeof rule.validator === 'function') {
        try {
          const validatorResult = rule.validator(response);
          if (!validatorResult) {
            result.valid = false;
            result.issues.push('Custom validation failed');
          }
        } catch (error) {
          result.valid = false;
          result.issues.push(`Validator error: ${error.message}`);
        }
      }
    }

    this.validationHistory.push({
      type: 'response',
      valid: result.valid,
      method,
      timestamp: Date.now()
    });

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
 * Universal adapter combining normalization, formatting, and validation
 * Provides single entry point for protocol-agnostic request/response handling
 */
class UniversalAdapter {
  constructor() {
    this.normalizer = new RequestNormalizer();
    this.formatter = new ResponseFormatter();
    this.validator = new AdapterValidator();
    this.adaptationHistory = [];
  }

  /**
   * Adapt incoming request to internal format
   * @param {Object} request - Incoming request
   * @param {string} protocolHint - Optional protocol hint
   * @returns {Object} Adaptation result
   */
  adaptRequest(request, protocolHint = null) {
    const result = {
      success: false,
      normalized: null,
      validation: null,
      issues: []
    };

    try {
      // Normalize
      result.normalized = this.normalizer.normalize(request, protocolHint);

      // Validate
      result.validation = this.validator.validateRequest(result.normalized);
      result.success = result.validation.valid;

      if (!result.success) {
        result.issues = result.validation.issues;
      }
    } catch (error) {
      result.success = false;
      result.issues.push(error.message);
    }

    this.recordAdaptation('request', result.success);
    return result;
  }

  /**
   * Adapt internal response to output format
   * @param {Object} unifiedResponse - Internal response
   * @param {string} targetProtocol - Target protocol
   * @returns {Object} Adaptation result
   */
  adaptResponse(unifiedResponse, targetProtocol) {
    const result = {
      success: false,
      formatted: null,
      validation: null,
      issues: []
    };

    try {
      // Format
      result.formatted = this.formatter.format(unifiedResponse, targetProtocol);

      // Validate
      result.validation = this.validator.validateResponse(
        result.formatted,
        unifiedResponse.method
      );
      result.success = result.validation.valid;

      if (!result.success) {
        result.issues = result.validation.issues;
      }
    } catch (error) {
      result.success = false;
      result.issues.push(error.message);
    }

    this.recordAdaptation('response', result.success);
    return result;
  }

  /**
   * Round-trip: normalize request and format response
   * @param {Object} request - Incoming request
   * @param {Object} unifiedResponse - Internal response
   * @param {string} protocolHint - Optional source protocol hint
   * @returns {Object} Complete adaptation result
   */
  roundTrip(request, unifiedResponse, protocolHint = null) {
    const requestAdaptation = this.adaptRequest(request, protocolHint);

    if (!requestAdaptation.success) {
      return {
        success: false,
        requestAdaptation,
        issues: requestAdaptation.issues
      };
    }

    const sourceProtocol = requestAdaptation.normalized.originalProtocol;
    const responseAdaptation = this.adaptResponse(unifiedResponse, sourceProtocol);

    return {
      success: responseAdaptation.success,
      requestAdaptation,
      responseAdaptation,
      sourceProtocol,
      targetProtocol: sourceProtocol,
      issues: responseAdaptation.issues
    };
  }

  /**
   * Record adaptation in history
   * @param {string} type - Adaptation type (request/response)
   * @param {boolean} success - Success status
   */
  recordAdaptation(type, success) {
    this.adaptationHistory.push({
      type,
      success,
      timestamp: Date.now()
    });

    if (this.adaptationHistory.length > 1000) {
      this.adaptationHistory = this.adaptationHistory.slice(-1000);
    }
  }

  /**
   * Get adaptation history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.adaptationHistory];
  }

  /**
   * Get adapter statistics
   * @returns {Object} Stats
   */
  getStats() {
    const history = this.adaptationHistory;
    const total = history.length;
    const successful = history.filter(h => h.success).length;

    return {
      totalAdaptations: total,
      successfulAdaptations: successful,
      failedAdaptations: total - successful,
      successRate: total > 0 ? (successful / total * 100).toFixed(2) : 0
    };
  }
}

module.exports = {
  RequestNormalizer,
  ResponseFormatter,
  AdapterValidator,
  UniversalAdapter
};
