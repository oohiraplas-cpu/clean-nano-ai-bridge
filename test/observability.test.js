const test = require('node:test');
const assert = require('node:assert');
const {
  MetricsCollector,
  TraceContext,
  TraceCollector,
  StructuredLogger,
  ObservabilityHub
} = require('../src/observability');

test('Observability', async (t) => {
  await t.test('MetricsCollector', async (t) => {
    await t.test('increments counters', () => {
      const collector = new MetricsCollector();

      collector.incrementCounter('requests', 1);
      collector.incrementCounter('requests', 1);

      const value = collector.getCounter('requests');
      assert.strictEqual(value, 2);
    });

    await t.test('records histograms', () => {
      const collector = new MetricsCollector();

      collector.recordHistogram('latency', 100);
      collector.recordHistogram('latency', 200);
      collector.recordHistogram('latency', 300);

      const stats = collector.getHistogramStats('latency');
      assert.strictEqual(stats.count, 3);
      assert.strictEqual(stats.min, 100);
      assert.strictEqual(stats.max, 300);
    });

    await t.test('sets gauges', () => {
      const collector = new MetricsCollector();

      collector.setGauge('memory', 1024);
      const value = collector.getGauge('memory');
      assert.strictEqual(value, 1024);
    });

    await t.test('labels metrics', () => {
      const collector = new MetricsCollector();

      collector.incrementCounter('requests', 1, { method: 'GET' });
      collector.incrementCounter('requests', 1, { method: 'POST' });

      assert.strictEqual(collector.getCounter('requests', { method: 'GET' }), 1);
      assert.strictEqual(collector.getCounter('requests', { method: 'POST' }), 1);
    });

    await t.test('calculates percentiles', () => {
      const collector = new MetricsCollector();

      for (let i = 1; i <= 100; i++) {
        collector.recordHistogram('latency', i);
      }

      const stats = collector.getHistogramStats('latency');
      assert.ok(stats.p50);
      assert.ok(stats.p95);
      assert.ok(stats.p99);
      assert.ok(stats.p50 <= stats.p95);
      assert.ok(stats.p95 <= stats.p99);
    });

    await t.test('gets all metrics', () => {
      const collector = new MetricsCollector();

      collector.incrementCounter('count', 1);
      collector.recordHistogram('latency', 100);
      collector.setGauge('value', 42);

      const metrics = collector.getMetrics();
      assert.ok(metrics.counters);
      assert.ok(metrics.histograms);
      assert.ok(metrics.gauges);
      assert.ok(metrics.uptime >= 0);
    });

    await t.test('resets metrics', () => {
      const collector = new MetricsCollector();

      collector.incrementCounter('count', 5);
      assert.strictEqual(collector.getCounter('count'), 5);

      collector.reset();
      assert.strictEqual(collector.getCounter('count'), 0);
    });
  });

  await t.test('TraceContext', async (t) => {
    await t.test('creates trace context', () => {
      const trace = new TraceContext('trace-123');

      assert.strictEqual(trace.traceId, 'trace-123');
      assert.ok(trace.spanId);
      assert.strictEqual(trace.span.status, 'active');
    });

    await t.test('sets span name', () => {
      const trace = new TraceContext('trace-1');
      trace.setSpanName('GET /api/users');

      assert.strictEqual(trace.span.name, 'GET /api/users');
    });

    await t.test('adds attributes', () => {
      const trace = new TraceContext('trace-1');
      trace.setAttribute('userId', '123');
      trace.setAttribute('method', 'GET');

      assert.strictEqual(trace.span.attributes.userId, '123');
      assert.strictEqual(trace.span.attributes.method, 'GET');
    });

    await t.test('adds events', () => {
      const trace = new TraceContext('trace-1');
      trace.addEvent('database_query', { query: 'SELECT *' });
      trace.addEvent('cache_miss');

      assert.strictEqual(trace.span.events.length, 2);
      assert.strictEqual(trace.span.events[0].name, 'database_query');
    });

    await t.test('ends span', () => {
      const trace = new TraceContext('trace-1');
      trace.end('ok');

      assert.strictEqual(trace.span.status, 'ok');
      assert.ok(trace.endTime);
    });

    await t.test('calculates duration', () => {
      const trace = new TraceContext('trace-1');
      const start = Date.now();

      // Simulate some work
      let sum = 0;
      for (let i = 0; i < 1000000; i++) {
        sum += i;
      }

      trace.end();
      const duration = trace.getDuration();
      assert.ok(duration >= 0);
    });

    await t.test('serializes to JSON', () => {
      const trace = new TraceContext('trace-1', 'parent-1');
      trace.setSpanName('operation');
      trace.end();

      const json = trace.toJSON();
      assert.strictEqual(json.traceId, 'trace-1');
      assert.strictEqual(json.parentSpanId, 'parent-1');
      assert.ok(json.duration >= 0);
    });
  });

  await t.test('TraceCollector', async (t) => {
    await t.test('creates traces', () => {
      const collector = new TraceCollector();
      const trace = collector.createTrace('corr-123');

      assert.ok(trace);
      assert.strictEqual(trace.traceId, 'corr-123');
    });

    await t.test('stores traces', () => {
      const collector = new TraceCollector();
      const trace = collector.createTrace('corr-1');
      trace.end();

      collector.storeTrace(trace);
      assert.strictEqual(collector.getTrace('corr-1').length, 1);
    });

    await t.test('gets trace summary', () => {
      const collector = new TraceCollector();
      const trace = collector.createTrace('corr-1');
      trace.end();
      collector.storeTrace(trace);

      const summary = collector.getTraceSummary('corr-1');
      assert.ok(summary);
      assert.strictEqual(summary.spanCount, 1);
    });

    await t.test('enforces max traces', () => {
      const collector = new TraceCollector();
      collector.maxTraces = 10;

      for (let i = 0; i < 15; i++) {
        const trace = collector.createTrace(`corr-${i}`);
        trace.end();
        collector.storeTrace(trace);
      }

      assert.strictEqual(collector.traces.size, 10);
    });

    await t.test('clears traces', () => {
      const collector = new TraceCollector();
      const trace = collector.createTrace('corr-1');
      trace.end();
      collector.storeTrace(trace);

      collector.clear();
      assert.strictEqual(collector.traces.size, 0);
    });
  });

  await t.test('StructuredLogger', async (t) => {
    await t.test('logs at debug level', () => {
      const logger = new StructuredLogger({ level: 'debug' });

      logger.debug('debug message');
      assert.strictEqual(logger.logs.length, 1);
    });

    await t.test('respects log level', () => {
      const logger = new StructuredLogger({ level: 'error' });

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      // Only error should be logged
      assert.strictEqual(logger.logs.length, 1);
      assert.strictEqual(logger.logs[0].level, 'error');
    });

    await t.test('adds context to logs', () => {
      const logger = new StructuredLogger({ level: 'info' });

      logger.info('operation', {
        correlationId: 'corr-1',
        action: 'update',
        status: 'success'
      });

      const log = logger.logs[0];
      assert.strictEqual(log.correlationId, 'corr-1');
      assert.strictEqual(log.action, 'update');
    });

    await t.test('filters logs by level', () => {
      const logger = new StructuredLogger();

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const errors = logger.getLogs({ level: 'error' });
      assert.strictEqual(errors.length, 1);
    });

    await t.test('filters logs by correlation ID', () => {
      const logger = new StructuredLogger();

      logger.info('msg1', { correlationId: 'corr-1' });
      logger.info('msg2', { correlationId: 'corr-2' });
      logger.info('msg3', { correlationId: 'corr-1' });

      const logs = logger.getLogs({ correlationId: 'corr-1' });
      assert.strictEqual(logs.length, 2);
    });

    await t.test('respects log limit', () => {
      const logger = new StructuredLogger();

      for (let i = 0; i < 10; i++) {
        logger.info(`msg${i}`);
      }

      const logs = logger.getLogs({ limit: 3 });
      assert.strictEqual(logs.length, 3);
    });

    await t.test('includes errors', () => {
      const logger = new StructuredLogger();
      const err = new Error('test error');

      logger.error('failed', { error: err });

      const log = logger.logs[0];
      assert.ok(log.error);
      assert.strictEqual(log.error.message, 'test error');
    });

    await t.test('gets summary', () => {
      const logger = new StructuredLogger({ level: 'debug' });

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const summary = logger.getSummary();
      assert.strictEqual(summary.total, 4);
      assert.strictEqual(summary.byLevel.debug, 1);
      assert.strictEqual(summary.byLevel.error, 1);
    });

    await t.test('clears logs', () => {
      const logger = new StructuredLogger();

      logger.info('msg');
      assert.strictEqual(logger.logs.length, 1);

      logger.clear();
      assert.strictEqual(logger.logs.length, 0);
    });
  });

  await t.test('ObservabilityHub', async (t) => {
    await t.test('starts and ends requests', () => {
      const hub = new ObservabilityHub();

      const trace = hub.startRequest('corr-1', 'GET', '/api/test');
      hub.endRequest(trace, 200);

      assert.strictEqual(hub.metrics.getCounter('http.requests', { method: 'GET' }), 1);
    });

    await t.test('records operation metrics', () => {
      const hub = new ObservabilityHub();

      hub.recordOperation('corr-1', 'save', true, 100);
      hub.recordOperation('corr-1', 'save', false, 200);

      assert.strictEqual(hub.metrics.getCounter('operation.count', { type: 'save' }), 2);
      assert.strictEqual(hub.metrics.getCounter('operation.success', { type: 'save' }), 1);
      assert.strictEqual(hub.metrics.getCounter('operation.error', { type: 'save' }), 1);
    });

    await t.test('records HTTP errors', () => {
      const hub = new ObservabilityHub();

      const trace = hub.startRequest('corr-1', 'POST', '/api/data');
      hub.endRequest(trace, 500);

      assert.strictEqual(hub.metrics.getCounter('http.errors', { status: 500 }), 1);
    });

    await t.test('gets observability summary', () => {
      const hub = new ObservabilityHub();

      const trace = hub.startRequest('corr-1', 'GET', '/api');
      hub.endRequest(trace, 200);

      const summary = hub.getSummary();
      assert.ok(summary.uptime >= 0);
      assert.ok(summary.metrics);
      assert.ok(summary.traces);
      assert.ok(summary.logs);
    });

    await t.test('clears all data', () => {
      const hub = new ObservabilityHub();

      hub.recordOperation('corr-1', 'op', true, 50);
      const trace = hub.startRequest('corr-1', 'GET', '/');
      hub.endRequest(trace, 200);

      hub.clear();

      assert.strictEqual(hub.metrics.getCounter('operation.count'), 0);
      assert.strictEqual(hub.traces.traces.size, 0);
      assert.strictEqual(hub.logger.logs.length, 0);
    });
  });
});
