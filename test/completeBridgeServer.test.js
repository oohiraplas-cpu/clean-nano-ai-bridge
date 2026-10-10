/**
 * Tests for Complete Bridge Server
 * Covers server factory, request/response handling, and Express integration
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  BridgeServerFactory,
  BridgeRequestHandler,
  BridgeResponseHandler,
  CompleteBridgeServer
} = require('../src/completeBridgeServer');

test('BridgeServerFactory', async (t) => {
  await t.test('initializes with default config', () => {
    const factory = new BridgeServerFactory();

    assert.strictEqual(factory.serverConfig.port, 3000);
    assert.strictEqual(factory.serverConfig.host, '0.0.0.0');
    assert.strictEqual(factory.serverConfig.environment, 'development');
  });

  await t.test('sets custom configuration', () => {
    const factory = new BridgeServerFactory();
    factory.setConfig({ port: 8080, host: 'localhost' });

    assert.strictEqual(factory.serverConfig.port, 8080);
    assert.strictEqual(factory.serverConfig.host, 'localhost');
  });

  await t.test('registers components', () => {
    const factory = new BridgeServerFactory();
    const component = { name: 'test', health: () => ({ status: 'healthy' }) };

    factory.registerComponent('test-component', component);

    assert.ok(factory.components['test-component']);
    assert.strictEqual(factory.components['test-component'], component);
  });

  await t.test('throws on invalid component', () => {
    const factory = new BridgeServerFactory();

    assert.throws(() => factory.registerComponent('test', null), /Component name and instance required/);
    assert.throws(() => factory.registerComponent(null, {}), /Component name and instance required/);
  });

  await t.test('adds middleware', () => {
    const factory = new BridgeServerFactory();
    const mw = (req, res, next) => next();

    factory.addMiddleware(mw);

    assert.strictEqual(factory.middleware.length, 1);
    assert.strictEqual(factory.middleware[0], mw);
  });

  await t.test('throws on invalid middleware', () => {
    const factory = new BridgeServerFactory();

    assert.throws(() => factory.addMiddleware('not-a-function'), /Middleware must be a function/);
  });

  await t.test('registers routes', () => {
    const factory = new BridgeServerFactory();
    const handler = (req, res) => res.json({ ok: true });

    factory.registerRoute('GET', '/test', handler);

    assert.strictEqual(factory.routes.length, 1);
    assert.strictEqual(factory.routes[0].method, 'GET');
    assert.strictEqual(factory.routes[0].path, '/test');
  });

  await t.test('throws on invalid route', () => {
    const factory = new BridgeServerFactory();

    assert.throws(() => factory.registerRoute('GET', '/test', null), /Route requires method, path, and handler/);
  });

  await t.test('returns factory statistics', () => {
    const factory = new BridgeServerFactory();
    factory.registerComponent('comp1', {});
    factory.registerComponent('comp2', {});
    factory.addMiddleware((req, res, next) => next());
    factory.registerRoute('GET', '/test', (req, res) => {});

    const stats = factory.getStats();

    assert.strictEqual(stats.componentsRegistered, 2);
    assert.strictEqual(stats.middlewareCount, 1);
    assert.strictEqual(stats.routesCount, 1);
    assert.ok(stats.configuration);
  });
});

test('BridgeRequestHandler', async (t) => {
  await t.test('processes valid HTTP request', async () => {
    const handler = new BridgeRequestHandler({
      validator: {
        validateRequest: (data) => ({ valid: true })
      }
    });

    const req = {
      method: 'POST',
      path: '/api/test',
      headers: { 'Content-Type': 'application/json' },
      body: { data: 'test' },
      query: {}
    };

    const result = await handler.processRequest(req);

    assert.strictEqual(result.success, true);
    assert.ok(result.requestId);
    assert.ok(result.processed);
  });

  await t.test('handles validation failure', async () => {
    const handler = new BridgeRequestHandler({
      validator: {
        validateRequest: (data) => ({ valid: false })
      }
    });

    const req = {
      method: 'POST',
      path: '/api/test',
      headers: {},
      body: {},
      query: {}
    };

    const result = await handler.processRequest(req);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errors.length, 1);
  });

  await t.test('tracks request history', async () => {
    const handler = new BridgeRequestHandler({});

    await handler.processRequest({ method: 'GET', path: '/', headers: {}, body: {}, query: {} });
    await handler.processRequest({ method: 'POST', path: '/api', headers: {}, body: {}, query: {} });

    const history = handler.getHistory();

    assert.strictEqual(history.length, 2);
    assert.ok(history[0].requestId);
    assert.ok(history[1].requestId);
  });

  await t.test('limits history to 1000 entries', async () => {
    const handler = new BridgeRequestHandler({});

    for (let i = 0; i < 1100; i++) {
      await handler.processRequest({ method: 'GET', path: '/', headers: {}, body: {}, query: {} });
    }

    const history = handler.getHistory();

    assert.strictEqual(history.length, 1000);
  });

  await t.test('records request duration', async () => {
    const handler = new BridgeRequestHandler({});

    const result = await handler.processRequest({ method: 'GET', path: '/', headers: {}, body: {}, query: {} });

    assert.ok(result.duration >= 0);
  });

  await t.test('processes request with empty object', async () => {
    const handler = new BridgeRequestHandler({});

    const result = await handler.processRequest({});

    assert.ok(result.requestId);
  });

  await t.test('creates operation context when available', async () => {
    let contextCreated = false;
    const handler = new BridgeRequestHandler({
      contextManager: {
        createRootContext: (userId, method, metadata) => {
          contextCreated = true;
          return { userId, method, metadata };
        }
      }
    });

    const req = {
      method: 'POST',
      path: '/api/test',
      headers: {},
      body: {},
      query: {},
      user: { id: 'user-1' }
    };

    await handler.processRequest(req);

    assert.strictEqual(contextCreated, true);
  });

  await t.test('adapts request when adapter available', async () => {
    let adaptCalled = false;
    const handler = new BridgeRequestHandler({
      adapter: {
        adaptRequest: (data) => {
          adaptCalled = true;
          return { success: true, normalized: data };
        }
      }
    });

    await handler.processRequest({ method: 'GET', path: '/', headers: {}, body: {}, query: {} });

    assert.strictEqual(adaptCalled, true);
  });
});

test('BridgeResponseHandler', async (t) => {
  await t.test('generates response from operation result', () => {
    const handler = new BridgeResponseHandler({});
    const operationResult = {
      success: true,
      status: 200,
      data: { saved: true },
      error: null
    };

    const response = handler.generateResponse(operationResult, 'http', { operationId: 'op-1' });

    assert.strictEqual(response.success, true);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.data, { saved: true });
    assert.strictEqual(response.error, null);
  });

  await t.test('sets default status 200 for success', () => {
    const handler = new BridgeResponseHandler({});
    const operationResult = {
      success: true,
      data: { result: 'ok' },
      error: null
    };

    const response = handler.generateResponse(operationResult);

    assert.strictEqual(response.status, 200);
  });

  await t.test('sets default status 400 for failure', () => {
    const handler = new BridgeResponseHandler({});
    const operationResult = {
      success: false,
      data: null,
      error: { message: 'Failed' }
    };

    const response = handler.generateResponse(operationResult);

    assert.strictEqual(response.status, 400);
  });

  await t.test('includes metadata in response', () => {
    const handler = new BridgeResponseHandler({});
    const operationResult = {
      success: true,
      data: {},
      error: null
    };

    const response = handler.generateResponse(operationResult, 'http', {
      operationId: 'op-1',
      correlationId: 'corr-1'
    });

    assert.ok(response.metadata);
    assert.strictEqual(response.metadata.operationId, 'op-1');
    assert.strictEqual(response.metadata.correlationId, 'corr-1');
  });

  await t.test('tracks response history', () => {
    const handler = new BridgeResponseHandler({});
    const response1 = { status: 200, error: null };
    const response2 = { status: 500, error: { message: 'Error' } };

    handler.recordResponse(response1);
    handler.recordResponse(response2);

    const history = handler.getHistory();

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].status, 200);
    assert.strictEqual(history[1].hasError, true);
  });

  await t.test('limits response history to 1000 entries', () => {
    const handler = new BridgeResponseHandler({});

    for (let i = 0; i < 1100; i++) {
      handler.recordResponse({ status: 200, error: null });
    }

    const history = handler.getHistory();

    assert.strictEqual(history.length, 1000);
  });

  await t.test('adapts response when adapter available', () => {
    let adaptCalled = false;
    const handler = new BridgeResponseHandler({
      adapter: {
        adaptResponse: (response, protocol) => {
          adaptCalled = true;
          return { success: true, formatted: response };
        }
      }
    });

    const operationResult = {
      success: true,
      data: {},
      error: null
    };

    handler.generateResponse(operationResult, 'http');

    assert.strictEqual(adaptCalled, true);
  });
});

test('CompleteBridgeServer', async (t) => {
  await t.test('initializes with components', () => {
    const server = new CompleteBridgeServer();
    const components = {
      validator: { validateRequest: () => ({}) },
      adapter: { adaptRequest: () => ({}) }
    };

    server.initialize(components, { port: 8080 });

    assert.ok(server.app === null); // Not created until start
    assert.ok(server.requestHandler);
    assert.ok(server.responseHandler);
  });

  await t.test('throws on missing components', () => {
    const server = new CompleteBridgeServer();

    assert.throws(() => server.initialize(null), /Components required for initialization/);
  });

  await t.test('creates error handler', () => {
    const server = new CompleteBridgeServer();

    const handler = server.createErrorHandler();

    assert.strictEqual(typeof handler, 'function');
  });

  await t.test('creates logging middleware', () => {
    const server = new CompleteBridgeServer();

    const middleware = server.createLoggingMiddleware();

    assert.strictEqual(typeof middleware, 'function');
  });

  await t.test('creates health check handler', () => {
    const server = new CompleteBridgeServer();
    server.factory.registerComponent('test', {});

    const handler = server.createHealthCheckHandler();

    assert.strictEqual(typeof handler, 'function');
  });

  await t.test('creates API handler', () => {
    const server = new CompleteBridgeServer();
    server.initialize({}, {});

    const handler = server.createApiHandler();

    assert.strictEqual(typeof handler, 'function');
  });

  await t.test('returns server statistics', () => {
    const server = new CompleteBridgeServer();
    server.factory.registerComponent('comp1', {});
    server.initialize({}, {});

    const stats = server.getStats();

    assert.ok(stats.factory);
    assert.ok(stats.requestHandler);
    assert.ok(stats.responseHandler);
    assert.ok(stats.server);
  });

  await t.test('returns server status', () => {
    const server = new CompleteBridgeServer();
    server.initialize({}, {});

    const status = server.getStatus();

    assert.strictEqual(status.running, false);
    assert.strictEqual(status.initialized, false);
    assert.ok(Array.isArray(status.components));
    assert.ok(Array.isArray(status.routes));
  });

  await t.test('initializes with custom configuration', () => {
    const server = new CompleteBridgeServer();
    const config = { port: 9000, host: 'localhost', environment: 'production' };

    server.initialize({}, config);

    assert.strictEqual(server.factory.serverConfig.port, 9000);
    assert.strictEqual(server.factory.serverConfig.host, 'localhost');
    assert.strictEqual(server.factory.serverConfig.environment, 'production');
  });

  await t.test('registers factory components correctly', () => {
    const server = new CompleteBridgeServer();
    const components = {
      validator: {},
      adapter: {},
      contextManager: {}
    };

    server.initialize(components, {});

    const stats = server.factory.getStats();
    assert.strictEqual(stats.componentsRegistered, 3);
  });
});

test('Integration: Complete Server Setup', async (t) => {
  await t.test('initializes complete server with all components', () => {
    const server = new CompleteBridgeServer();
    const components = {
      validator: {
        validateRequest: (data) => ({ valid: true })
      },
      adapter: {
        adaptRequest: (req) => ({ success: true, normalized: req }),
        adaptResponse: (res, protocol) => ({ success: true, formatted: res })
      },
      contextManager: {
        createRootContext: (userId, method, metadata) => ({
          userId,
          method,
          metadata
        })
      }
    };

    server.initialize(components, { port: 3000, host: 'localhost' });

    assert.ok(server.requestHandler);
    assert.ok(server.responseHandler);
    assert.ok(server.factory.components['validator']);
    assert.ok(server.factory.components['adapter']);
    assert.ok(server.factory.components['contextManager']);
  });

  await t.test('processes request through handler pipeline', async () => {
    const server = new CompleteBridgeServer();
    server.initialize({}, {});

    const req = {
      method: 'POST',
      path: '/api/test',
      headers: { 'Content-Type': 'application/json' },
      body: { data: 'test' },
      query: {}
    };

    const result = await server.requestHandler.processRequest(req);

    assert.ok(result.requestId);
    assert.ok(result.processed);
  });

  await t.test('generates response through handler pipeline', async () => {
    const server = new CompleteBridgeServer();
    server.initialize({}, {});

    const operationResult = {
      success: true,
      status: 200,
      data: { result: 'ok' },
      error: null
    };

    const response = server.responseHandler.generateResponse(operationResult, 'http', {
      operationId: 'op-1'
    });

    assert.strictEqual(response.success, true);
    assert.strictEqual(response.status, 200);
    assert.ok(response.metadata);
  });

  await t.test('validates request/response round-trip', async () => {
    const server = new CompleteBridgeServer();
    server.initialize({}, {});

    // Process request
    const req = {
      method: 'POST',
      path: '/api/save',
      headers: {},
      body: { data: 'test' },
      query: {}
    };

    const requestResult = await server.requestHandler.processRequest(req);
    assert.strictEqual(requestResult.success, true);

    // Generate response
    const operationResult = {
      success: true,
      status: 200,
      data: { saved: true },
      error: null
    };

    const response = server.responseHandler.generateResponse(operationResult, 'http', {
      operationId: requestResult.requestId
    });

    assert.strictEqual(response.success, true);
    assert.strictEqual(response.metadata.operationId, requestResult.requestId);
  });

  await t.test('maintains separate request and response histories', async () => {
    const server = new CompleteBridgeServer();
    server.initialize({}, {});

    // Process multiple requests
    for (let i = 0; i < 3; i++) {
      await server.requestHandler.processRequest({
        method: 'GET',
        path: '/',
        headers: {},
        body: {},
        query: {}
      });
    }

    // Generate multiple responses
    for (let i = 0; i < 2; i++) {
      server.responseHandler.generateResponse(
        { success: true, data: {}, error: null },
        'http'
      );
    }

    const reqHistory = server.requestHandler.getHistory();
    const respHistory = server.responseHandler.getHistory();

    assert.strictEqual(reqHistory.length, 3);
    assert.strictEqual(respHistory.length, 2);
  });
});
