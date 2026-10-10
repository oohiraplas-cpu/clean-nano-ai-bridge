/**
 * Phase 12: Runtime Evidence Engine
 * Captures and verifies real-world operation execution, proving that deployed code actually works
 *
 * Runtime Evidence categories:
 * 1. App Startup Evidence - app launched, initial state verified
 * 2. User Interaction Evidence - user actions (click, input, navigation)
 * 3. Data Binding Evidence - data correctly bound to UI controls
 * 4. Formula Execution Evidence - formulas executed and returned expected values
 * 5. Connection Evidence - Power Platform connections active and responding
 * 6. Error Event Evidence - runtime errors, warnings, exception handling
 * 7. State Transition Evidence - app state changes, UI screen transitions
 * 8. Performance Evidence - response times, rendering latency, API call times
 * 9. Behavior Verification Evidence - user-observable behavior matches specification
 * 10. Integration Evidence - cross-app/cross-service communication verified
 */
const crypto = require('node:crypto');

/**
 * @typedef {Object} RuntimeEvidence
 * @property {string} id - unique evidence record ID (UUID)
 * @property {string} correlationId - links to operation context
 * @property {string} category - evidence type
 * @property {string} timestamp - ISO 8601
 * @property {*} payload - evidence data
 * @property {boolean} verified - human verification status
 * @property {string} signature - HMAC-SHA256 integrity proof
 */

class RuntimeEvidenceEngine {
  constructor(options = {}) {
    this.options = {
      signingKey: options.signingKey || crypto.randomBytes(32).toString('hex'),
      retentionDays: options.retentionDays || 90,
      performanceThreshold: options.performanceThreshold || 5000, // ms
      ...options
    };

    this.evidenceCategories = [
      'app_startup',
      'user_interaction',
      'data_binding',
      'formula_execution',
      'connection',
      'error_event',
      'state_transition',
      'performance',
      'behavior_verification',
      'integration'
    ];

    this.records = [];
    this.sessions = new Map(); // correlationId -> session context
  }

  /**
   * Generate cryptographic signature for evidence integrity
   */
  signEvidence(payload) {
    const hmac = crypto.createHmac('sha256', this.options.signingKey);
    hmac.update(JSON.stringify(payload));
    return hmac.digest('hex');
  }

  /**
   * Category 1: App startup and initialization
   */
  captureAppStartup(context) {
    const {
      appId,
      appVersion,
      environment,
      correlationId,
      startupTime,
      initialState,
      screenLoaded,
      connectionsInitialized,
      dataSourcesLoaded
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      appId,
      appVersion,
      environment,
      startupTime, // milliseconds
      initialState: initialState || {},
      screenLoaded: screenLoaded || false,
      connectionsInitialized: connectionsInitialized || false,
      dataSourcesLoaded: dataSourcesLoaded || [],
      readiness: {
        uiReady: screenLoaded || false,
        dataReady: dataSourcesLoaded?.length > 0 || false,
        connectionsReady: connectionsInitialized || false
      },
      startupPhases: context.startupPhases || []
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId: correlationId || crypto.randomUUID(),
      category: 'app_startup',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    if (correlationId) {
      this.initializeSessionContext(correlationId, { appId, environment });
    }
    return record;
  }

  /**
   * Category 2: User interaction events
   */
  captureUserInteraction(context) {
    const {
      appId,
      screenName,
      controlName,
      interactionType, // 'click', 'input', 'navigation', 'selection'
      correlationId,
      inputValue,
      timestamp,
      userEmail
    } = context;

    const payload = {
      timestamp: timestamp || new Date().toISOString(),
      appId,
      screenName,
      controlName,
      interactionType,
      inputValue: inputValue || null,
      userEmail: userEmail || null,
      metadata: context.metadata || {}
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'user_interaction',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 3: Data binding verification
   */
  captureDataBinding(context) {
    const {
      appId,
      screenName,
      controlName,
      dataSourceName,
      correlationId,
      expectedValue,
      actualValue,
      bindingExpression,
      bindingStatus // 'bound', 'error', 'pending'
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      appId,
      screenName,
      controlName,
      dataSourceName,
      bindingExpression,
      bindingStatus,
      expectedValue,
      actualValue,
      matchesExpectation: JSON.stringify(expectedValue) === JSON.stringify(actualValue),
      dataType: context.dataType || null,
      recordCount: context.recordCount || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'data_binding',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 4: Formula execution verification
   */
  captureFormulaExecution(context) {
    const {
      appId,
      formulaName,
      formulaExpression,
      correlationId,
      inputParameters,
      expectedOutput,
      actualOutput,
      executionTime,
      errorInfo
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      appId,
      formulaName,
      formulaExpression,
      inputParameters: inputParameters || {},
      expectedOutput,
      actualOutput,
      executionTime, // milliseconds
      matchesExpectation: JSON.stringify(expectedOutput) === JSON.stringify(actualOutput),
      errorInfo: errorInfo || null,
      formulaLanguage: context.formulaLanguage || 'PowerFx'
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'formula_execution',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 5: Connection status and API calls
   */
  captureConnection(context) {
    const {
      appId,
      connectionName,
      connectionType, // 'SharePoint', 'Dataverse', 'Power Automate', etc.
      correlationId,
      status, // 'connected', 'error', 'timeout'
      responseTime,
      apiCall,
      apiResponse,
      errorInfo
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      appId,
      connectionName,
      connectionType,
      status,
      responseTime, // milliseconds
      apiCall: apiCall || null,
      apiResponseHash: crypto.createHash('sha256').update(JSON.stringify(apiResponse || {})).digest('hex').substring(0, 16),
      errorInfo: errorInfo || null,
      authenticated: context.authenticated || false,
      rateLimit: context.rateLimit || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'connection',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 6: Runtime errors and exceptions
   */
  captureErrorEvent(context) {
    const {
      appId,
      screenName,
      errorType, // 'formula_error', 'connection_error', 'validation_error', 'runtime_exception'
      correlationId,
      errorMessage,
      errorStack,
      timestamp,
      severity, // 'error', 'warning', 'fatal'
      handled // boolean - was error caught/handled
    } = context;

    const payload = {
      timestamp: timestamp || new Date().toISOString(),
      appId,
      screenName,
      errorType,
      errorMessage,
      errorStack: errorStack || null,
      severity: severity || 'error',
      handled: handled || false,
      sourceControl: context.sourceControl || null,
      suggestions: context.suggestions || []
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'error_event',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 7: State transitions and navigation
   */
  captureStateTransition(context) {
    const {
      appId,
      fromScreen,
      toScreen,
      correlationId,
      transitionType, // 'navigation', 'overlay', 'modal', 'dialog'
      timestamp,
      context: transitionContext,
      dataCarried
    } = context;

    const payload = {
      timestamp: timestamp || new Date().toISOString(),
      appId,
      fromScreen,
      toScreen,
      transitionType,
      context: transitionContext || {},
      dataCarried: dataCarried || null,
      transitionTime: context.transitionTime || null,
      screenReadyTime: context.screenReadyTime || null,
      renderingComplete: context.renderingComplete || false
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'state_transition',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 8: Performance metrics
   */
  capturePerformance(context) {
    const {
      appId,
      operationName,
      correlationId,
      startTime,
      endTime,
      duration,
      timestamp
    } = context;

    const payload = {
      timestamp: timestamp || new Date().toISOString(),
      appId,
      operationName,
      startTime,
      endTime,
      duration, // milliseconds
      threshold: this.options.performanceThreshold,
      withinThreshold: (duration || 0) <= this.options.performanceThreshold,
      metrics: context.metrics || {
        renderTime: context.renderTime || null,
        apiCallTime: context.apiCallTime || null,
        dataLoadTime: context.dataLoadTime || null
      },
      resourceUsage: context.resourceUsage || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'performance',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 9: Behavior verification (user-observable behavior)
   */
  captureBehaviorVerification(context) {
    const {
      appId,
      scenario, // 'user saves record', 'app displays list', etc.
      correlationId,
      expectedBehavior,
      observedBehavior,
      verified, // boolean
      timestamp,
      evidence: behaviorEvidence
    } = context;

    const payload = {
      timestamp: timestamp || new Date().toISOString(),
      appId,
      scenario,
      expectedBehavior,
      observedBehavior,
      matches: verified || false,
      evidence: behaviorEvidence || [],
      verificationMethod: context.verificationMethod || 'manual',
      userFeedback: context.userFeedback || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'behavior_verification',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 10: Integration verification (cross-app/cross-service)
   */
  captureIntegration(context) {
    const {
      appId,
      integrationType, // 'sharepoint_sync', 'power_automate', 'cross_app', 'external_api'
      correlationId,
      sourceSystem,
      targetSystem,
      dataTransferred,
      timestamp,
      status, // 'success', 'partial', 'failed'
      recordsAffected
    } = context;

    const payload = {
      timestamp: timestamp || new Date().toISOString(),
      appId,
      integrationType,
      sourceSystem,
      targetSystem,
      dataTransferred: dataTransferred || {},
      status,
      recordsAffected: recordsAffected || 0,
      consistencyVerified: context.consistencyVerified || false,
      reconciliation: context.reconciliation || null,
      warnings: context.warnings || []
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'integration',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Initialize session context for a correlation ID
   */
  initializeSessionContext(correlationId, context) {
    if (!this.sessions.has(correlationId)) {
      this.sessions.set(correlationId, {
        correlationId,
        startTime: new Date().toISOString(),
        appId: context.appId,
        environment: context.environment,
        evidenceCount: 0,
        categories: new Set()
      });
    }
  }

  /**
   * Update session with evidence
   */
  updateSessionContext(correlationId, category) {
    if (this.sessions.has(correlationId)) {
      const session = this.sessions.get(correlationId);
      session.evidenceCount++;
      session.categories.add(category);
      session.lastUpdate = new Date().toISOString();
    }
  }

  /**
   * Generate comprehensive runtime report
   */
  generateRuntimeReport(correlationId) {
    const recordsForCorrelation = this.records.filter(r => r.correlationId === correlationId);
    const session = this.sessions.get(correlationId);

    const report = {
      correlationId,
      reportId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      recordCount: recordsForCorrelation.length,
      categories: {},
      timeline: [],
      integrityStatus: 'VALID',
      verificationStatus: 'UNVERIFIED',
      appStartupVerified: false,
      userInteractionsRecorded: 0,
      errorEventsRecorded: 0,
      performanceOk: true,
      behaviorVerified: false,
      session: session || null
    };

    // Group by category
    for (const record of recordsForCorrelation) {
      if (!report.categories[record.category]) {
        report.categories[record.category] = [];
      }
      report.categories[record.category].push(record);
    }

    // Build timeline
    report.timeline = recordsForCorrelation
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .map(r => ({
        timestamp: r.timestamp,
        category: r.category,
        id: r.id
      }));

    // Calculate statistics
    if (report.categories.app_startup) {
      report.appStartupVerified = report.categories.app_startup[0]?.payload?.screenLoaded || false;
    }
    if (report.categories.user_interaction) {
      report.userInteractionsRecorded = report.categories.user_interaction.length;
    }
    if (report.categories.error_event) {
      report.errorEventsRecorded = report.categories.error_event.length;
    }
    if (report.categories.performance) {
      report.performanceOk = report.categories.performance.every(r => r.payload.withinThreshold);
    }
    if (report.categories.behavior_verification) {
      report.behaviorVerified = report.categories.behavior_verification.some(r => r.payload.matches);
    }

    // Verify all signatures
    report.integrityStatus = recordsForCorrelation.every(r => {
      const expectedSig = this.signEvidence(r.payload);
      return expectedSig === r.signature;
    }) ? 'VALID' : 'TAMPERED';

    // Check if verified
    const verifiedCount = recordsForCorrelation.filter(r => r.verified).length;
    report.verificationStatus = verifiedCount === recordsForCorrelation.length ? 'VERIFIED' : `PARTIAL (${verifiedCount}/${recordsForCorrelation.length})`;

    // Overall readiness
    report.overallReadiness = {
      uiReady: report.appStartupVerified,
      userCanInteract: report.userInteractionsRecorded > 0,
      performanceAcceptable: report.performanceOk,
      noBlockingErrors: (report.categories.error_event || []).every(r => !['fatal', 'error'].includes(r.payload.severity)),
      behaviorMatchesSpecification: report.behaviorVerified
    };

    return report;
  }

  /**
   * Verify records as authentic
   */
  verifyRecords(correlationId, verifier) {
    const verified = [];
    for (const record of this.records) {
      if (record.correlationId === correlationId && !record.verified) {
        record.verified = true;
        record.verifier = verifier;
        verified.push(record);
      }
    }
    return verified;
  }

  /**
   * Health check - verify app is operating normally
   */
  isAppHealthy(correlationId) {
    const recordsForCorrelation = this.records.filter(r => r.correlationId === correlationId);

    // Check for blocking errors
    const blockingErrors = recordsForCorrelation.filter(r =>
      r.category === 'error_event' &&
      ['fatal', 'error'].includes(r.payload.severity) &&
      !r.payload.handled
    );

    // Check startup
    const startup = recordsForCorrelation.find(r => r.category === 'app_startup');
    const startupOk = startup?.payload?.readiness?.uiReady &&
                      startup?.payload?.readiness?.dataReady &&
                      startup?.payload?.readiness?.connectionsReady;

    // Check performance
    const performanceRecords = recordsForCorrelation.filter(r => r.category === 'performance');
    const performanceOk = performanceRecords.length === 0 ||
                         performanceRecords.every(r => r.payload.withinThreshold);

    // Check recent interactions (within last 60 seconds)
    const now = Date.now();
    const recentInteractions = recordsForCorrelation.filter(r => {
      const recordTime = new Date(r.timestamp).getTime();
      return (now - recordTime) < 60000 && r.category === 'user_interaction';
    });

    return {
      healthy: blockingErrors.length === 0 && startupOk && performanceOk,
      blockingErrors: blockingErrors.length,
      startupStatus: startupOk ? 'ready' : 'not_ready',
      performanceStatus: performanceOk ? 'acceptable' : 'degraded',
      recentActivitySeconds: Math.floor((now - new Date(recordsForCorrelation[recordsForCorrelation.length - 1]?.timestamp).getTime()) / 1000),
      readinessScore: ((startupOk ? 1 : 0) + (performanceOk ? 1 : 0) + (blockingErrors.length === 0 ? 1 : 0)) / 3
    };
  }

  /**
   * Export runtime evidence
   */
  exportEvidence(correlationId) {
    const recordsForCorrelation = this.records.filter(r => r.correlationId === correlationId);
    const report = this.generateRuntimeReport(correlationId);

    return {
      exportId: crypto.randomUUID(),
      exportTimestamp: new Date().toISOString(),
      runtimeReport: report,
      fullRecords: recordsForCorrelation,
      healthStatus: this.isAppHealthy(correlationId)
    };
  }

  /**
   * Cleanup old records (by retention policy)
   */
  cleanupOldRecords() {
    const cutoffDate = new Date(Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000);
    const before = this.records.length;
    this.records = this.records.filter(r => new Date(r.timestamp) >= cutoffDate);
    return {
      deletedCount: before - this.records.length,
      remainingCount: this.records.length,
      cutoffDate: cutoffDate.toISOString()
    };
  }

  /**
   * Get statistics
   */
  getStatistics() {
    const totalRecords = this.records.length;
    const categories = {};
    const correlations = new Set();

    for (const record of this.records) {
      if (!categories[record.category]) {
        categories[record.category] = 0;
      }
      categories[record.category]++;
      correlations.add(record.correlationId);
    }

    const errorRecords = this.records.filter(r => r.category === 'error_event');
    const errorRate = totalRecords > 0 ? (errorRecords.length / totalRecords * 100).toFixed(2) : 0;

    const performanceRecords = this.records.filter(r => r.category === 'performance');
    const avgPerformance = performanceRecords.length > 0
      ? performanceRecords.reduce((sum, r) => sum + (r.payload.duration || 0), 0) / performanceRecords.length
      : null;

    return {
      totalRecords,
      totalCorrelations: correlations.size,
      categories,
      errorRate: `${errorRate}%`,
      errorCount: errorRecords.length,
      averagePerformanceMs: avgPerformance ? Math.round(avgPerformance) : null,
      verifiedRecords: this.records.filter(r => r.verified).length
    };
  }
}

module.exports = { RuntimeEvidenceEngine };
