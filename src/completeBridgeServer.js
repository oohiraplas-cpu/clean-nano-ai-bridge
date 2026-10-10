/**
 * Complete Bridge Server
 *
 * Integrates all Bridge components into a functional Express HTTP server:
 * - Server factory with dependency injection
 * - Unified request handling pipeline
 * - Response generation and formatting
 * - Complete request/response lifecycle
 * - Health check endpoints
 * - Comprehensive error handling with Japanese messaging
 *
 * Provides the complete Bridge API implementation with Fail-Closed enforcement.
 */

/**
 * Factory for creating and configuring the Bridge server
 */
class BridgeServerFactory {
  constructor() {
    this.serverConfig = {
      port: process.env.PORT || 3000,
      host: process.env.HOST || '0.0.0.0',
      environment: process.env.NODE_ENV || 'development'
    };
    this.components = {};
    this.middleware = [];
    this.routes = [];
  }

  /**
   * Set server configuration
   * @param {Object} config - Configuration object
   */
  setConfig(config) {
    this.serverConfig = { ...this.serverConfig, ...config };
  }

  /**
   * Register component
   * @param {string} name - Component name
   * @param {Object} component - Component instance
   */
  registerComponent(name, component) {
    if (!name || !component) {
      throw new Error('Component name and instance required');
    }
    this.components[name] = component;
  }

  /**
   * Add middleware
   * @param {Function} middlewareFunc - Middleware function
   */
  addMiddleware(middlewareFunc) {
    if (typeof middlewareFunc !== 'function') {
      throw new Error('Middleware must be a function');
    }
    this.middleware.push(middlewareFunc);
  }

  /**
   * Register route
   * @param {string} method - HTTP method
   * @param {string} path - Route path
   * @param {Function} handler - Route handler
   */
  registerRoute(method, path, handler) {
    if (!method || !path || !handler) {
      throw new Error('Route requires method, path, and handler');
    }
    this.routes.push({ method, path, handler });
  }

  /**
   * Create configured server instance
   * @param {Object} express - Express instance
   * @returns {Object} Configured Express app
   */
  createServer(express) {
    if (!express) {
      throw new Error('Express instance required');
    }

    const app = express();

    // Apply middleware
    app.use(express.json());
    for (const mw of this.middleware) {
      app.use(mw);
    }

    // Register routes
    for (const route of this.routes) {
      const method = route.method.toLowerCase();
      if (typeof app[method] === 'function') {
        app[method](route.path, route.handler);
      }
    }

    return app;
  }

  /**
   * Get factory statistics
   * @returns {Object} Stats
   */
  getStats() {
    return {
      componentsRegistered: Object.keys(this.components).length,
      middlewareCount: this.middleware.length,
      routesCount: this.routes.length,
      configuration: this.serverConfig
    };
  }
}

/**
 * Handles unified request processing through Bridge pipeline
 */
class BridgeRequestHandler {
  constructor(components, orchestrator) {
    this.components = components;
    this.orchestrator = orchestrator;
    this.requestHistory = [];
  }

  /**
   * Process incoming request through complete pipeline
   * @param {Object} req - Express request
   * @param {Object} context - Execution context
   * @returns {Object} Processed request result
   */
  async processRequest(req, context = {}) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const result = {
      requestId,
      success: false,
      processed: null,
      validated: null,
      errors: [],
      startTime: Date.now()
    };

    try {
      // Extract request data
      const requestData = {
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body,
        query: req.query
      };

      // Validate request
      if (this.components.validator) {
        result.validated = this.components.validator.validateRequest(requestData);
        if (!result.validated.valid) {
          result.errors.push('リクエスト検証失敗');
          result.endTime = Date.now();
          result.duration = result.endTime - result.startTime;
          this.recordRequest(result);
          return result;
        }
      }

      // Normalize request
      let normalizedRequest = requestData;
      if (this.components.adapter) {
        const adaptResult = this.components.adapter.adaptRequest(requestData);
        if (!adaptResult.success) {
          result.errors.push('リクエスト適応失敗');
          result.endTime = Date.now();
          result.duration = result.endTime - result.startTime;
          this.recordRequest(result);
          return result;
        }
        normalizedRequest = adaptResult.normalized;
      }

      // Create operation context
      let operationContext = context;
      if (this.components.contextManager) {
        operationContext = this.components.contextManager.createRootContext(
          req.user?.id || 'anonymous',
          req.method,
          { path: req.path }
        );
      }

      result.processed = normalizedRequest;
      result.success = true;
    } catch (error) {
      result.success = false;
      result.errors.push(`リクエスト処理エラー: ${error.message}`);
    }

    result.endTime = Date.now();
    result.duration = result.endTime - result.startTime;
    this.recordRequest(result);

    return result;
  }

  /**
   * Record request in history
   * @param {Object} result - Request result
   */
  recordRequest(result) {
    this.requestHistory.push({
      requestId: result.requestId,
      success: result.success,
      duration: result.duration,
      timestamp: Date.now()
    });

    // Limit history
    if (this.requestHistory.length > 1000) {
      this.requestHistory = this.requestHistory.slice(-1000);
    }
  }

  /**
   * Get request history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.requestHistory];
  }
}

/**
 * Handles response generation and formatting
 */
class BridgeResponseHandler {
  constructor(components) {
    this.components = components;
    this.responseHistory = [];
  }

  /**
   * Generate response from operation result
   * @param {Object} operationResult - Result from operation
   * @param {string} requestProtocol - Source request protocol
   * @param {Object} context - Execution context
   * @returns {Object} Formatted response
   */
  generateResponse(operationResult, requestProtocol = 'http', context = {}) {
    const response = {
      success: operationResult.success !== false,
      status: operationResult.status || (operationResult.success ? 200 : 400),
      data: operationResult.data || null,
      error: operationResult.error || null,
      metadata: {
        timestamp: Date.now(),
        operationId: context.operationId,
        correlationId: context.correlationId
      }
    };

    let formatted = response;

    // Format for target protocol
    if (this.components.adapter) {
      const formatResult = this.components.adapter.adaptResponse(response, requestProtocol);
      if (formatResult.success) {
        formatted = formatResult.formatted;
      }
    }

    this.recordResponse(formatted);
    return formatted;
  }

  /**
   * Send response through Express
   * @param {Object} res - Express response
   * @param {Object} response - Response object
   */
  sendResponse(res, response) {
    const status = response.status || response.statusCode || 200;
    const headers = response.headers || { 'Content-Type': 'application/json' };
    const body = response.body || response;

    res.status(status).set(headers).json(body);
  }

  /**
   * Send error response
   * @param {Object} res - Express response
   * @param {number} status - HTTP status
   * @param {string} message - Error message
   * @param {string} code - Error code
   */
  sendError(res, status, message, code = 'ERROR') {
    const response = {
      success: false,
      error: {
        message: message || 'エラーが発生しました',
        code: code
      },
      metadata: {
        timestamp: Date.now()
      }
    };

    res.status(status).json(response);
  }

  /**
   * Record response in history
   * @param {Object} response - Response object
   */
  recordResponse(response) {
    this.responseHistory.push({
      status: response.status || response.statusCode,
      hasError: !!response.error,
      timestamp: Date.now()
    });

    // Limit history
    if (this.responseHistory.length > 1000) {
      this.responseHistory = this.responseHistory.slice(-1000);
    }
  }

  /**
   * Get response history
   * @returns {Array} History entries
   */
  getHistory() {
    return [...this.responseHistory];
  }
}

/**
 * Complete Bridge Server combining all components
 */
class CompleteBridgeServer {
  constructor() {
    this.factory = new BridgeServerFactory();
    this.requestHandler = null;
    this.responseHandler = null;
    this.app = null;
    this.server = null;
  }

  /**
   * Initialize server with components
   * @param {Object} components - Component dictionary
   * @param {Object} config - Server configuration
   */
  initialize(components, config = {}) {
    if (!components) {
      throw new Error('Components required for initialization');
    }

    // Register components
    for (const [name, component] of Object.entries(components)) {
      this.factory.registerComponent(name, component);
    }

    // Set configuration
    if (config) {
      this.factory.setConfig(config);
    }

    // Create handlers
    this.requestHandler = new BridgeRequestHandler(components);
    this.responseHandler = new BridgeResponseHandler(components);

    return this;
  }

  /**
   * Setup error handling middleware
   * @returns {Function} Error handler middleware
   */
  createErrorHandler() {
    return (err, req, res, next) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || '内部エラーが発生しました';
      const code = err.code || 'INTERNAL_ERROR';

      this.responseHandler.sendError(res, status, message, code);
    };
  }

  /**
   * Setup request logging middleware
   * @returns {Function} Logging middleware
   */
  createLoggingMiddleware() {
    return (req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        // Could log to external system
      });
      next();
    };
  }

  /**
   * Create health check route handler
   * @returns {Function} Route handler
   */
  createHealthCheckHandler() {
    const self = this;
    return (req, res) => {
      const response = {
        success: true,
        status: 'healthy',
        timestamp: Date.now(),
        components: Object.keys(self.factory.components)
      };

      res.status(200).json(response);
    };
  }

  /**
   * Create unified API route handler
   * @returns {Function} Route handler
   */
  createApiHandler() {
    const self = this;
    return async (req, res) => {
      try {
        const requestResult = await self.requestHandler.processRequest(req);

        if (!requestResult.success) {
          return self.responseHandler.sendError(
            res,
            400,
            requestResult.errors[0],
            'REQUEST_PROCESSING_FAILED'
          );
        }

        const operationResult = {
          success: true,
          data: requestResult.processed,
          status: 200
        };

        const response = self.responseHandler.generateResponse(
          operationResult,
          'http',
          { operationId: requestResult.requestId }
        );

        self.responseHandler.sendResponse(res, response);
      } catch (error) {
        self.responseHandler.sendError(res, 500, error.message, 'SERVER_ERROR');
      }
    };
  }

  /**
   * Start server
   * @param {Object} express - Express module
   * @param {number} port - Port to listen on (optional)
   * @returns {Promise} Server start promise
   */
  async start(express, port = null) {
    if (!express) {
      throw new Error('Express module required');
    }

    // Create Express app
    this.app = this.factory.createServer(express);

    // Add middleware
    this.app.use(this.createLoggingMiddleware());

    // Add routes
    this.app.get('/health', this.createHealthCheckHandler());
    this.app.post('/api/execute', this.createApiHandler());
    this.app.post('/webhooks/claude-code', this.createApiHandler());
    this.app.post('/webhooks/copilot', this.createApiHandler());

    // Add error handler
    this.app.use(this.createErrorHandler());

    // Start listening
    const listenPort = port || this.factory.serverConfig.port;
    const listenHost = this.factory.serverConfig.host;

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(listenPort, listenHost, () => {
        resolve({
          host: listenHost,
          port: listenPort,
          started: Date.now()
        });
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Stop server
   * @returns {Promise} Server stop promise
   */
  async stop() {
    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Get server statistics
   * @returns {Object} Comprehensive statistics
   */
  getStats() {
    return {
      factory: this.factory.getStats(),
      requestHandler: {
        requestCount: this.requestHandler ? this.requestHandler.requestHistory.length : 0
      },
      responseHandler: {
        responseCount: this.responseHandler ? this.responseHandler.responseHistory.length : 0
      },
      server: {
        running: !!this.server,
        port: this.factory.serverConfig.port,
        host: this.factory.serverConfig.host
      }
    };
  }

  /**
   * Get server status
   * @returns {Object} Status info
   */
  getStatus() {
    return {
      running: !!this.server,
      initialized: !!this.app,
      components: Object.keys(this.factory.components),
      routes: this.factory.routes.map(r => ({ method: r.method, path: r.path }))
    };
  }
}

module.exports = {
  BridgeServerFactory,
  BridgeRequestHandler,
  BridgeResponseHandler,
  CompleteBridgeServer
};
