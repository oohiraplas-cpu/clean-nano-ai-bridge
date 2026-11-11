/**
 * Observability: Metrics, Distributed Tracing, Structured Logging
 *
 * Provides comprehensive observability:
 * - Request/response metrics (latency, throughput)
 * - Operation metrics (success rate, error rate)
 * - System health metrics (CPU, memory, GC)
 * - Distributed tracing with correlation IDs
 * - Structured logging with context
 */

/**
 * Metrics Collector for tracking performance
 */
class MetricsCollector {
  constructor() {
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
    this.startTime = Date.now();
  }

  /**
   * Increment counter
   */
  incrementCounter(name, value = 1, labels = {}) {
    const key = this._makeKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
  }

  /**
   * Record histogram value
   */
  recordHistogram(name, value, labels = {}) {
    const key = this._makeKey(name, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    this.histograms.get(key).push(value);
  }

  /**
   * Set gauge value
   */
  setGauge(name, value, labels = {}) {
    const key = this._makeKey(name, labels);
    this.gauges.set(key, value);
  }

  /**
   * Create key from name and labels
   */
  _makeKey(name, labels) {
    if (Object.keys(labels).length === 0) return name;
    const parts = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`);
    return `${name}{${parts.join(',')}}`;
  }

  /**
   * Get counter value
   */
  getCounter(name, labels = {}) {
    return this.counters.get(this._makeKey(name, labels)) || 0;
  }

  /**
   * Get histogram stats
   */
  getHistogramStats(name, labels = {}) {
    const key = this._makeKey(name, labels);
    const values = this.histograms.get(key) || [];
    if (values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / sorted.length;

    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: Math.round(mean * 100) / 100,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      sum
    };
  }

  /**
   * Get gauge value
   */
  getGauge(name, labels = {}) {
    return this.gauges.get(this._makeKey(name, labels));
  }

  /**
   * Get all metrics
   */
  getMetrics() {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(
        Array.from(this.histograms).map(([k, v]) => [k, this.getHistogramStats(k)])
      ),
      gauges: Object.fromEntries(this.gauges),
      uptime: Date.now() - this.startTime
    };
  }

  /**
   * Reset metrics
   */
  reset() {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }
}

/**
 * Distributed Trace context holder
 */
class TraceContext {
  constructor(correlationId, parentSpanId = null) {
    this.traceId = correlationId;
    this.spanId = this._generateSpanId();
    this.parentSpanId = parentSpanId;
    this.startTime = Date.now();
    this.endTime = null;
    this.span = {
      name: null,
      status: 'active',
      attributes: {},
      events: []
    };
  }

  /**
   * Generate span ID
   */
  _generateSpanId() {
    return Math.random().toString(16).substring(2, 18);
  }

  /**
   * Set span name
   */
  setSpanName(name) {
    this.span.name = name;
    return this;
  }

  /**
   * Add attribute
   */
  setAttribute(key, value) {
    this.span.attributes[key] = value;
    return this;
  }

  /**
   * Add event
   */
  addEvent(name, attributes = {}) {
    this.span.events.push({
      name,
      timestamp: Date.now(),
      attributes
    });
    return this;
  }

  /**
   * End span
   */
  end(status = 'ok', reason = null) {
    this.endTime = Date.now();
    this.span.status = status;
    if (reason) {
      this.span.reason = reason;
    }
    return this;
  }

  /**
   * Get duration
   */
  getDuration() {
    const end = this.endTime || Date.now();
    return end - this.startTime;
  }

  /**
   * Get trace data
   */
  toJSON() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.getDuration(),
      span: this.span
    };
  }
}

/**
 * Trace Collector for managing distributed traces
 */
class TraceCollector {
  constructor() {
    this.traces = new Map(); // traceId -> [spans]
    this.maxTraces = 10000;
    this.maxSpansPerTrace = 1000;
  }

  /**
   * Create trace context
   */
  createTrace(correlationId, parentSpanId = null) {
    const trace = new TraceContext(correlationId, parentSpanId);
    return trace;
  }

  /**
   * Store completed trace
   */
  storeTrace(trace) {
    if (!this.traces.has(trace.traceId)) {
      this.traces.set(trace.traceId, []);
    }

    const spans = this.traces.get(trace.traceId);
    if (spans.length < this.maxSpansPerTrace) {
      spans.push(trace.toJSON());
    }

    // Cleanup old traces
    if (this.traces.size > this.maxTraces) {
      const firstKey = this.traces.keys().next().value;
      this.traces.delete(firstKey);
    }
  }

  /**
   * Get trace
   */
  getTrace(traceId) {
    return this.traces.get(traceId);
  }

  /**
   * Get trace summary
   */
  getTraceSummary(traceId) {
    const spans = this.traces.get(traceId);
    if (!spans || spans.length === 0) {
      return null;
    }

    const totalDuration = spans.reduce((sum, s) => sum + s.duration, 0);
    const failedSpans = spans.filter(s => s.span.status !== 'ok').length;

    return {
      traceId,
      spanCount: spans.length,
      totalDuration,
      failedSpans,
      spans
    };
  }

  /**
   * Get all traces
   */
  getTraces() {
    return Array.from(this.traces.entries()).map(([traceId, spans]) => ({
      traceId,
      spanCount: spans.length,
      totalDuration: spans.reduce((sum, s) => sum + s.duration, 0),
      spans
    }));
  }

  /**
   * Clear traces
   */
  clear() {
    this.traces.clear();
  }
}

/**
 * Structured Logger with context
 */
class StructuredLogger {
  constructor(options = {}) {
    this.level = options.level || 'info'; // debug, info, warn, error
    this.maxLogs = options.maxLogs || 100000;
    this.logs = [];
    this.levelOrder = { debug: 0, info: 1, warn: 2, error: 3 };
  }

  /**
   * Check if should log
   */
  _shouldLog(level) {
    return this.levelOrder[level] >= this.levelOrder[this.level];
  }

  /**
   * Log message
   */
  log(level, message, context = {}) {
    if (!this._shouldLog(level)) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      correlationId: context.correlationId,
      spanId: context.spanId,
      principal: context.principal,
      action: context.action,
      resource: context.resource,
      status: context.status,
      details: context.details,
      error: context.error ? {
        message: context.error.message,
        stack: context.error.stack
      } : null
    };

    this.logs.push(entry);

    // Keep recent logs only
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  /**
   * Convenience methods
   */
  debug(message, context = {}) { this.log('debug', message, context); }
  info(message, context = {}) { this.log('info', message, context); }
  warn(message, context = {}) { this.log('warn', message, context); }
  error(message, context = {}) { this.log('error', message, context); }

  /**
   * Get logs
   */
  getLogs(filter = {}) {
    let results = this.logs;

    if (filter.level) {
      results = results.filter(l => l.level === filter.level);
    }

    if (filter.correlationId) {
      results = results.filter(l => l.correlationId === filter.correlationId);
    }

    if (filter.action) {
      results = results.filter(l => l.action === filter.action);
    }

    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Get log summary
   */
  getSummary() {
    const summary = {
      total: this.logs.length,
      byLevel: { debug: 0, info: 0, warn: 0, error: 0 },
      errors: []
    };

    for (const log of this.logs) {
      summary.byLevel[log.level]++;
      if (log.error) {
        summary.errors.push({
          timestamp: log.timestamp,
          message: log.error.message,
          context: log.message
        });
      }
    }

    return summary;
  }

  /**
   * Clear logs
   */
  clear() {
    this.logs = [];
  }
}

/**
 * Observability Hub: Combines metrics, tracing, logging
 */
class ObservabilityHub {
  constructor(options = {}) {
    this.metrics = new MetricsCollector();
    this.traces = new TraceCollector();
    this.logger = new StructuredLogger(options);
    this.startTime = Date.now();
  }

  /**
   * Start request
   */
  startRequest(correlationId, method, path) {
    const trace = this.traces.createTrace(correlationId);
    trace.setSpanName(`${method} ${path}`);
    trace.setAttribute('method', method);
    trace.setAttribute('path', path);

    this.metrics.incrementCounter('http.requests', 1, { method });

    return trace;
  }

  /**
   * End request
   */
  endRequest(trace, statusCode, error = null) {
    trace.setAttribute('status_code', statusCode);

    if (statusCode >= 400) {
      trace.end('error', 'HTTP error');
      this.metrics.incrementCounter('http.errors', 1, { status: statusCode });
    } else {
      trace.end('ok');
    }

    const duration = trace.getDuration();
    this.metrics.recordHistogram('http.latency', duration, { status: statusCode });

    this.traces.storeTrace(trace);

    if (error) {
      this.logger.error('Request failed', {
        correlationId: trace.traceId,
        spanId: trace.spanId,
        error
      });
    }
  }

  /**
   * Record operation
   */
  recordOperation(correlationId, operationType, success, duration, error = null) {
    this.metrics.incrementCounter('operation.count', 1, { type: operationType });
    this.metrics.recordHistogram('operation.duration', duration, { type: operationType });

    if (success) {
      this.metrics.incrementCounter('operation.success', 1, { type: operationType });
    } else {
      this.metrics.incrementCounter('operation.error', 1, { type: operationType });
    }

    if (error) {
      this.logger.error(`Operation ${operationType} failed`, {
        correlationId,
        action: operationType,
        error
      });
    }
  }

  /**
   * Get observability summary
   */
  getSummary() {
    return {
      uptime: Date.now() - this.startTime,
      metrics: this.metrics.getMetrics(),
      traces: {
        count: this.traces.traces.size,
        samples: this.traces.getTraces().slice(0, 10)
      },
      logs: this.logger.getSummary()
    };
  }

  /**
   * Clear all data
   */
  clear() {
    this.metrics.reset();
    this.traces.clear();
    this.logger.clear();
  }
}

module.exports = {
  MetricsCollector,
  TraceContext,
  TraceCollector,
  StructuredLogger,
  ObservabilityHub
};
