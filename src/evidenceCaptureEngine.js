/**
 * Phase 9: Evidence Capture Engine
 * Records audit trails and proves every operation step with correlated evidence
 *
 * Evidence categories:
 * 1. Operation Evidence - what operation was requested, by whom, when
 * 2. Authorization Evidence - who approved it, what was the approval token
 * 3. State Evidence - before/after state snapshots for reproducibility
 * 4. Execution Evidence - GitHub API calls, Power Apps runtime responses, network traces
 * 5. Screen Evidence - Power Apps canvas/form state at key moments
 * 6. Audit Evidence - all state transitions, retry events, error states
 * 7. Correlation Evidence - trace IDs linking related operations
 * 8. Source Evidence - source file SHA256, branch, repository origin
 * 9. Runtime Evidence - deployed app state, behavior confirmation
 * 10. Remediation Evidence - rollback proof, recovery state
 */
const crypto = require('node:crypto');

/**
 * @typedef {Object} EvidenceRecord
 * @property {string} id - unique evidence record ID (UUID)
 * @property {string} correlationId - links related operations
 * @property {string} category - evidence type (operation, authorization, state, etc.)
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {*} payload - actual evidence data
 * @property {boolean} verified - human verification status
 * @property {string} verifier - who verified (email or system)
 * @property {string} signature - HMAC-SHA256 proof of integrity
 */

class EvidenceCaptureEngine {
  constructor(options = {}) {
    this.options = {
      signingKey: options.signingKey || crypto.randomBytes(32).toString('hex'),
      retentionDays: options.retentionDays || 365,
      ...options
    };

    this.evidenceCategories = [
      'operation_request',
      'authorization',
      'state_snapshot',
      'execution_trace',
      'screen_state',
      'audit_event',
      'correlation',
      'source_evidence',
      'runtime_state',
      'remediation'
    ];

    this.records = [];
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
   * Category 1: Record the operation request itself
   * who, what, when, why, with which approvals
   */
  captureOperationRequest(context) {
    const {
      operation,
      requestId,
      requester,
      timestamp,
      approvalToken,
      targetId,
      targetName,
      environment,
      correlationId
    } = context;

    const payload = {
      operation,
      requestId,
      requester,
      timestamp: timestamp || new Date().toISOString(),
      approvalTokenProvided: !!approvalToken,
      approvalTokenHash: approvalToken ? crypto.createHash('sha256').update(approvalToken).digest('hex').substring(0, 8) : null,
      targetId,
      targetName,
      environment,
      userAgent: context.userAgent || null,
      sourceIp: context.sourceIp || null,
      reason: context.reason || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId: correlationId || crypto.randomUUID(),
      category: 'operation_request',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 2: Record authorization evidence
   * who approved, what approval method, when, what scope
   */
  captureAuthorization(context) {
    const {
      approvalMethod,
      approver,
      approvalScope,
      correlationId,
      restrictedTo,
      ttlMinutes
    } = context;

    const payload = {
      approvalMethod, // token, mfa, email, oauth, etc.
      approver,
      approvalScope, // which operations/resources are approved
      timestamp: new Date().toISOString(),
      restrictedTo: restrictedTo || null, // specific app/target if any
      ttlMinutes: ttlMinutes || 60,
      expiresAt: new Date(Date.now() + (ttlMinutes || 60) * 60000).toISOString(),
      mfaVerified: context.mfaVerified || false,
      secondFactor: context.secondFactor || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'authorization',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 3: Record state snapshots for before/after comparison
   * app state, config, permissions, deployed version, etc.
   */
  captureStateSnapshot(context) {
    const {
      snapshotType, // 'before', 'after', 'checkpoint'
      appId,
      environment,
      correlationId,
      stateData
    } = context;

    const payload = {
      snapshotType,
      timestamp: new Date().toISOString(),
      appId,
      environment,
      state: stateData || {},
      stateHash: crypto.createHash('sha256').update(JSON.stringify(stateData || {})).digest('hex'),
      checksum: null // for reconstructing exact state
    };

    if (stateData?.branch || stateData?.sha) {
      payload.sourceState = {
        branch: stateData.branch,
        sha: stateData.sha,
        repository: stateData.repository
      };
    }

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'state_snapshot',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 4: Record execution traces and API calls
   * GitHub API calls, Power Apps runtime responses, network details
   */
  captureExecutionTrace(context) {
    const {
      apiEndpoint,
      apiMethod,
      correlationId,
      responseStatus,
      responseTime,
      requestPayload,
      responsePayload,
      errorInfo
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      apiEndpoint,
      apiMethod,
      requestId: context.requestId || null,
      responseStatus,
      responseTime, // milliseconds
      requestHash: crypto.createHash('sha256').update(JSON.stringify(requestPayload)).digest('hex').substring(0, 16),
      responseHash: crypto.createHash('sha256').update(JSON.stringify(responsePayload)).digest('hex').substring(0, 16),
      errorInfo: errorInfo || null,
      retryCount: context.retryCount || 0,
      retriedAfter: context.retriedAfter || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'execution_trace',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 5: Record Power Apps canvas/form state at key moments
   * screen rendering, user interactions, control values
   */
  captureScreenState(context) {
    const {
      appId,
      screenName,
      controlStates,
      userInteraction,
      correlationId,
      timestamp
    } = context;

    const payload = {
      timestamp: timestamp || new Date().toISOString(),
      appId,
      screenName,
      controls: controlStates || {},
      userInteractionType: userInteraction || null,
      rendering: {
        loadTime: context.loadTime || null,
        canvasState: context.canvasState || null
      }
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'screen_state',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 6: Record all audit events and state transitions
   * status changes, retries, error events, approval paths
   */
  captureAuditEvent(context) {
    const {
      eventType, // 'status_change', 'retry', 'error', 'approval', 'escalation'
      fromStatus,
      toStatus,
      correlationId,
      reason,
      actor
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      eventType,
      fromStatus: fromStatus || null,
      toStatus: toStatus || null,
      reason: reason || null,
      actor: actor || 'system',
      transitionTime: context.transitionTime || null,
      escalationLevel: context.escalationLevel || 0
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'audit_event',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 7: Record correlation evidence
   * links operations together (save→publish→verify), parent-child relationships
   */
  captureCorrelation(context) {
    const {
      correlationId,
      parentId,
      childIds,
      relationType, // 'parent_child', 'sequential', 'parallel', 'dependent'
      linkedOperations
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      correlationId,
      parentId: parentId || null,
      childIds: childIds || [],
      relationType,
      linkedOperations: linkedOperations || [],
      dependencyOrder: context.dependencyOrder || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'correlation',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 8: Record source evidence
   * GitHub file SHA, branch, repository origin, canonicality
   */
  captureSourceEvidence(context) {
    const {
      repository,
      branch,
      canonicalBranch,
      filePath,
      sha256,
      fileSize,
      correlationId,
      lastModified,
      commitMessage
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      repository,
      branch,
      canonicalBranch,
      isCanonicalBranch: branch === canonicalBranch,
      filePath,
      sha256,
      fileSize,
      lastModified: lastModified || null,
      commitMessage: commitMessage || null,
      origin: context.origin || null // 'github_canonical', 'github_fallback', etc.
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'source_evidence',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 9: Record runtime state after deployment
   * Power Apps version, runtime behavior, live data state
   */
  captureRuntimeState(context) {
    const {
      appId,
      appVersion,
      environment,
      correlationId,
      deployedAt,
      runtimeState,
      behaviorVerified
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      appId,
      appVersion,
      environment,
      deployedAt: deployedAt || null,
      runtimeState: runtimeState || {},
      behaviorVerified: behaviorVerified || false,
      dataState: context.dataState || null,
      connections: context.connections || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'runtime_state',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Category 10: Record remediation and rollback evidence
   * what was rolled back, to what state, who approved, verification
   */
  captureRemediation(context) {
    const {
      correlationId,
      remediationType, // 'rollback', 'recovery', 'manual_fix', 'automatic_retry'
      rolledBackFrom,
      rolledBackTo,
      remediationActor,
      reason
    } = context;

    const payload = {
      timestamp: new Date().toISOString(),
      remediationType,
      rolledBackFrom: rolledBackFrom || null,
      rolledBackTo: rolledBackTo || null,
      remediationActor: remediationActor || 'system',
      reason: reason || null,
      automatedRecovery: context.automatedRecovery || false,
      recoveryProof: context.recoveryProof || null
    };

    const record = {
      id: crypto.randomUUID(),
      correlationId,
      category: 'remediation',
      timestamp: new Date().toISOString(),
      payload,
      verified: false,
      verifier: null,
      signature: this.signEvidence(payload)
    };

    this.records.push(record);
    return record;
  }

  /**
   * Generate comprehensive audit report
   */
  generateAuditReport(correlationId) {
    const recordsForCorrelation = this.records.filter(r => r.correlationId === correlationId);

    const report = {
      correlationId,
      reportId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      recordCount: recordsForCorrelation.length,
      categories: {},
      timeline: [],
      integrityStatus: 'VALID',
      verificationStatus: 'UNVERIFIED',
      records: recordsForCorrelation
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

    // Verify all signatures
    report.integrityStatus = recordsForCorrelation.every(r => {
      const expectedSig = this.signEvidence(r.payload);
      return expectedSig === r.signature;
    }) ? 'VALID' : 'TAMPERED';

    // Check if verified
    const verifiedCount = recordsForCorrelation.filter(r => r.verified).length;
    report.verificationStatus = verifiedCount === recordsForCorrelation.length ? 'VERIFIED' : `PARTIAL (${verifiedCount}/${recordsForCorrelation.length})`;

    return report;
  }

  /**
   * Mark records as verified by human
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
   * Export evidence for archival or external audit
   */
  exportEvidence(correlationId) {
    const recordsForCorrelation = this.records.filter(r => r.correlationId === correlationId);
    const report = this.generateAuditReport(correlationId);

    return {
      exportId: crypto.randomUUID(),
      exportTimestamp: new Date().toISOString(),
      auditReport: report,
      fullRecords: recordsForCorrelation.map(r => ({
        ...r,
        // Redact sensitive payload details for export
        payload: this.redactSensitiveData(r.payload)
      }))
    };
  }

  /**
   * Redact sensitive data from evidence export
   */
  redactSensitiveData(payload) {
    const redacted = JSON.parse(JSON.stringify(payload));

    // Redact common sensitive fields
    const sensitiveFields = ['approvalToken', 'password', 'apiKey', 'secret', 'token'];
    for (const field of sensitiveFields) {
      if (field in redacted) {
        redacted[field] = '[REDACTED]';
      }
    }

    return redacted;
  }

  /**
   * Clean up old records (by retention policy)
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
}

module.exports = { EvidenceCaptureEngine };
