/**
 * Tests for Request/Response Adapter
 * Covers protocol normalization, response formatting, validation, and round-trip adaptation
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  RequestNormalizer,
  ResponseFormatter,
  AdapterValidator,
  UniversalAdapter
} = require('../src/requestResponseAdapter');

test('RequestNormalizer', async (t) => {
  await t.test('detects HTTP protocol', () => {
    const normalizer = new RequestNormalizer();
    const httpRequest = { method: 'POST', body: {} };

    const protocol = normalizer.detectProtocol(httpRequest);

    assert.strictEqual(protocol, 'http');
  });

  await t.test('detects MCP protocol', () => {
    const normalizer = new RequestNormalizer();
    const mcpRequest = { method: 'save_app' };

    const protocol = normalizer.detectProtocol(mcpRequest);

    assert.strictEqual(protocol, 'mcp');
  });

  await t.test('defaults to raw protocol', () => {
    const normalizer = new RequestNormalizer();
    const rawRequest = { operation: 'test' };

    const protocol = normalizer.detectProtocol(rawRequest);

    assert.strictEqual(protocol, 'raw');
  });

  await t.test('normalizes HTTP request', () => {
    const normalizer = new RequestNormalizer();
    const httpRequest = {
      method: 'POST',
      url: '/api/save',
      body: JSON.stringify({ data: 'test' }),
      headers: { 'Content-Type': 'application/json' }
    };

    const normalized = normalizer.normalizeHttpRequest(httpRequest);

    assert.strictEqual(normalized.protocol, 'http');
    assert.strictEqual(normalized.method, 'POST');
    assert.strictEqual(normalized.path, '/api/save');
    assert.deepStrictEqual(normalized.body, { data: 'test' });
  });

  await t.test('normalizes MCP request', () => {
    const normalizer = new RequestNormalizer();
    const mcpRequest = {
      method: 'save_app',
      params: { appId: 'test-app' }
    };

    const normalized = normalizer.normalizeMcpRequest(mcpRequest);

    assert.strictEqual(normalized.protocol, 'mcp');
    assert.strictEqual(normalized.method, 'save_app');
    assert.deepStrictEqual(normalized.body, { appId: 'test-app' });
  });

  await t.test('normalizes raw request', () => {
    const normalizer = new RequestNormalizer();
    const rawRequest = {
      method: 'validate',
      body: { config: 'test' }
    };

    const normalized = normalizer.normalizeRawRequest(rawRequest);

    assert.strictEqual(normalized.protocol, 'raw');
    assert.strictEqual(normalized.method, 'validate');
  });

  await t.test('auto-normalizes request with protocol detection', () => {
    const normalizer = new RequestNormalizer();
    const httpRequest = { method: 'POST', body: {} };

    const normalized = normalizer.normalize(httpRequest);

    assert.strictEqual(normalized.originalProtocol, 'http');
    assert.ok(normalized.normalizedAt);
  });

  await t.test('throws on invalid request', () => {
    const normalizer = new RequestNormalizer();
    assert.throws(() => normalizer.normalize(null), /cannot be null/);
  });

  await t.test('tracks normalization history', () => {
    const normalizer = new RequestNormalizer();
    normalizer.normalize({ method: 'POST', body: {} });
    normalizer.normalize({ method: 'save_app' });

    const history = normalizer.getHistory();

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].protocol, 'http');
    assert.strictEqual(history[1].protocol, 'mcp');
  });
});

test('ResponseFormatter', async (t) => {
  await t.test('formats response for HTTP', () => {
    const formatter = new ResponseFormatter();
    const response = {
      success: true,
      status: 200,
      data: { saved: true },
      error: null,
      operationId: 'op-1'
    };

    const formatted = formatter.formatHttpResponse(response);

    assert.strictEqual(formatted.status, 200);
    assert.strictEqual(formatted.statusCode, 200);
    assert.deepStrictEqual(formatted.body.success, true);
    assert.strictEqual(formatted.headers['Content-Type'], 'application/json');
  });

  await t.test('formats response for MCP', () => {
    const formatter = new ResponseFormatter();
    const response = {
      success: true,
      method: 'save_app',
      data: { appId: 'test' },
      error: null,
      operationId: 'op-1'
    };

    const formatted = formatter.formatMcpResponse(response);

    assert.strictEqual(formatted.accepted, true);
    assert.strictEqual(formatted.method, 'save_app');
    assert.strictEqual(formatted.error, null);
  });

  await t.test('formats response for raw/internal API', () => {
    const formatter = new ResponseFormatter();
    const response = {
      success: true,
      status: 'completed',
      data: { result: 'ok' },
      error: null,
      operationId: 'op-1'
    };

    const formatted = formatter.formatRawResponse(response);

    assert.strictEqual(formatted.success, true);
    assert.deepStrictEqual(formatted.data, { result: 'ok' });
    assert.ok(formatted.metadata);
  });

  await t.test('handles error in response formatting', () => {
    const formatter = new ResponseFormatter();
    const response = {
      success: false,
      data: null,
      error: { message: 'Operation failed', code: 'ERROR_001' }
    };

    const formatted = formatter.formatMcpResponse(response);

    assert.strictEqual(formatted.accepted, false);
    assert.ok(formatted.error);
    assert.strictEqual(formatted.error.message, 'Operation failed');
  });

  await t.test('throws on null response', () => {
    const formatter = new ResponseFormatter();
    assert.throws(() => formatter.formatHttpResponse(null), /cannot be null/);
  });

  await t.test('tracks format history', () => {
    const formatter = new ResponseFormatter();
    const response = { success: true, data: {}, error: null };

    formatter.format(response, 'http');
    formatter.format(response, 'mcp');

    const history = formatter.getHistory();

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].targetProtocol, 'http');
    assert.strictEqual(history[1].targetProtocol, 'mcp');
  });
});

test('AdapterValidator', async (t) => {
  await t.test('defines request validation rule', () => {
    const validator = new AdapterValidator();
    validator.defineRequestRule('save_app', { requiredFields: ['appId'] });

    assert.ok(validator.requestRules['save_app']);
  });

  await t.test('throws on invalid rule', () => {
    const validator = new AdapterValidator();
    assert.throws(() => validator.defineRequestRule('test', null), /Rule must be an object/);
  });

  await t.test('validates normalized request successfully', () => {
    const validator = new AdapterValidator();
    const request = {
      protocol: 'http',
      method: 'save',
      body: {}
    };

    const result = validator.validateRequest(request);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.issues.length, 0);
  });

  await t.test('detects missing required fields in request', () => {
    const validator = new AdapterValidator();
    const request = {
      method: 'save'
      // missing protocol and body
    };

    const result = validator.validateRequest(request);

    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.length > 0);
  });

  await t.test('validates request with custom rule', () => {
    const validator = new AdapterValidator();
    validator.defineRequestRule('save_app', {
      requiredFields: ['appId'],
      validator: (req) => req.body.appId !== undefined
    });

    const validRequest = {
      protocol: 'http',
      method: 'save_app',
      body: { appId: 'app-1' }
    };

    const result = validator.validateRequest(validRequest);

    assert.strictEqual(result.valid, true);
  });

  await t.test('validates response structure', () => {
    const validator = new AdapterValidator();
    const response = {
      success: true,
      data: { result: 'ok' },
      error: null
    };

    const result = validator.validateResponse(response, 'save_app');

    assert.strictEqual(result.valid, true);
  });

  await t.test('validates response with custom rule', () => {
    const validator = new AdapterValidator();
    validator.defineResponseRule('save_app', {
      requireData: true
    });

    const validResponse = {
      success: true,
      data: { saved: true },
      error: null
    };

    const result = validator.validateResponse(validResponse, 'save_app');

    assert.strictEqual(result.valid, true);
  });

  await t.test('tracks validation history', () => {
    const validator = new AdapterValidator();
    const request = { protocol: 'http', method: 'test', body: {} };
    const response = { success: true, data: {}, error: null };

    validator.validateRequest(request);
    validator.validateResponse(response, 'test');

    const history = validator.getHistory();

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].type, 'request');
    assert.strictEqual(history[1].type, 'response');
  });
});

test('UniversalAdapter', async (t) => {
  await t.test('adapts HTTP request successfully', () => {
    const adapter = new UniversalAdapter();
    const httpRequest = {
      method: 'POST',
      body: { data: 'test' },
      headers: {}
    };

    const result = adapter.adaptRequest(httpRequest);

    assert.strictEqual(result.success, true);
    assert.ok(result.normalized);
    assert.strictEqual(result.normalized.protocol, 'http');
  });

  await t.test('adapts MCP request successfully', () => {
    const adapter = new UniversalAdapter();
    const mcpRequest = {
      method: 'save_app',
      params: { appId: 'test' }
    };

    const result = adapter.adaptRequest(mcpRequest);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.normalized.originalProtocol, 'mcp');
  });

  await t.test('adapts response to HTTP format', () => {
    const adapter = new UniversalAdapter();
    const unifiedResponse = {
      success: true,
      data: { result: 'ok' },
      error: null,
      method: 'save'
    };

    const result = adapter.adaptResponse(unifiedResponse, 'http');

    assert.strictEqual(result.success, true);
    assert.ok(result.formatted);
    assert.strictEqual(result.formatted.status, 200);
  });

  await t.test('adapts response to MCP format', () => {
    const adapter = new UniversalAdapter();
    const unifiedResponse = {
      success: true,
      data: { appId: 'test' },
      error: null,
      method: 'save_app'
    };

    const result = adapter.adaptResponse(unifiedResponse, 'mcp');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.formatted.accepted, true);
  });

  await t.test('handles adaptation failure gracefully', () => {
    const adapter = new UniversalAdapter();
    const invalidRequest = null;

    const result = adapter.adaptRequest(invalidRequest);

    assert.strictEqual(result.success, false);
    assert.ok(result.issues.length > 0);
  });

  await t.test('performs round-trip adaptation', () => {
    const adapter = new UniversalAdapter();
    const httpRequest = {
      method: 'POST',
      body: { data: 'test' },
      headers: {}
    };
    const unifiedResponse = {
      success: true,
      data: { saved: true },
      error: null,
      method: 'POST'
    };

    const result = adapter.roundTrip(httpRequest, unifiedResponse);

    assert.strictEqual(result.success, true);
    assert.ok(result.requestAdaptation);
    assert.ok(result.responseAdaptation);
    assert.strictEqual(result.sourceProtocol, 'http');
    assert.strictEqual(result.targetProtocol, 'http');
  });

  await t.test('reports failed round-trip adaptation', () => {
    const adapter = new UniversalAdapter();
    const invalidRequest = null;
    const response = { success: true, data: {}, error: null };

    const result = adapter.roundTrip(invalidRequest, response);

    assert.strictEqual(result.success, false);
    assert.ok(result.issues.length > 0);
  });

  await t.test('preserves source protocol for response', () => {
    const adapter = new UniversalAdapter();
    const mcpRequest = {
      method: 'get_tasks',
      params: {}
    };
    const unifiedResponse = {
      success: true,
      data: [{ id: 'task-1' }],
      error: null,
      method: 'get_tasks'
    };

    const result = adapter.roundTrip(mcpRequest, unifiedResponse);

    assert.strictEqual(result.sourceProtocol, 'mcp');
    assert.strictEqual(result.targetProtocol, 'mcp');
    assert.ok(result.responseAdaptation.formatted.accepted);
  });

  await t.test('tracks adaptation history', () => {
    const adapter = new UniversalAdapter();
    adapter.adaptRequest({ method: 'POST', body: {} });
    adapter.adaptRequest({ method: 'save_app' });
    adapter.adaptResponse({ success: true, data: {}, error: null }, 'http');

    const history = adapter.getHistory();

    assert.strictEqual(history.length, 3);
  });

  await t.test('calculates adapter statistics', () => {
    const adapter = new UniversalAdapter();
    adapter.adaptRequest({ method: 'POST', body: {} });
    adapter.adaptRequest({ method: 'save_app' });
    adapter.adaptResponse({ success: true, data: {}, error: null }, 'http');

    const stats = adapter.getStats();

    assert.strictEqual(stats.totalAdaptations, 3);
    assert.ok(stats.successRate >= 0);
  });

  await t.test('integration: HTTP to HTTP round-trip', () => {
    const adapter = new UniversalAdapter();
    const httpRequest = {
      method: 'PUT',
      url: '/api/tasks/123',
      body: JSON.stringify({ status: 'completed' }),
      headers: { 'Content-Type': 'application/json' }
    };
    const unifiedResponse = {
      success: true,
      status: 200,
      data: { taskId: '123', status: 'completed' },
      error: null,
      method: 'PUT',
      operationId: 'op-1'
    };

    const result = adapter.roundTrip(httpRequest, unifiedResponse);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.sourceProtocol, 'http');
    assert.deepStrictEqual(result.responseAdaptation.formatted.body.data, {
      taskId: '123',
      status: 'completed'
    });
  });

  await t.test('integration: MCP to MCP round-trip', () => {
    const adapter = new UniversalAdapter();
    const mcpRequest = {
      method: 'update_app',
      params: { appId: 'app-1', changes: { title: 'New Title' } }
    };
    const unifiedResponse = {
      success: true,
      data: { appId: 'app-1', updated: true },
      error: null,
      method: 'update_app',
      operationId: 'op-2'
    };

    const result = adapter.roundTrip(mcpRequest, unifiedResponse);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.sourceProtocol, 'mcp');
    assert.strictEqual(result.responseAdaptation.formatted.accepted, true);
  });

  await t.test('integration: cross-protocol request normalization', () => {
    const adapter = new UniversalAdapter();

    const httpResult = adapter.adaptRequest({ method: 'POST', body: { test: 1 } });
    const mcpResult = adapter.adaptRequest({ method: 'save_app', params: { test: 1 } });

    assert.strictEqual(httpResult.normalized.method, 'POST');
    assert.strictEqual(mcpResult.normalized.method, 'save_app');
    assert.strictEqual(httpResult.success, true);
    assert.strictEqual(mcpResult.success, true);
  });
});
