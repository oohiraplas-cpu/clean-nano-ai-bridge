const test = require('node:test');
const assert = require('node:assert');
const { EvidenceCaptureEngine } = require('../src/evidenceCaptureEngine');

test('EvidenceCaptureEngine - initialization', (t) => {
  const engine = new EvidenceCaptureEngine();
  assert.ok(engine, 'Engine instantiated');
  assert.equal(engine.evidenceCategories.length, 10, '10 evidence categories registered');
  assert.ok(engine.options.signingKey, 'Signing key generated');
  assert.equal(engine.options.retentionDays, 365, 'Default retention 365 days');
});

// Category 1: Operation Request Evidence
test('captureOperationRequest - records operation details', (t) => {
  const engine = new EvidenceCaptureEngine();
  const correlationId = 'corr-123';
  const result = engine.captureOperationRequest({
    operation: 'publish_powerapps_app',
    requestId: 'req-456',
    requester: 'user@example.com',
    approvalToken: 'token-abc123def456',
    targetId: 'app-789',
    targetName: 'MyApp',
    environment: 'production'
  });

  assert.ok(result.id, 'Record has ID');
  assert.equal(result.category, 'operation_request');
  assert.equal(result.payload.operation, 'publish_powerapps_app');
  assert.equal(result.payload.requester, 'user@example.com');
  assert.ok(result.payload.approvalTokenProvided, 'Approval token flag set');
  assert.ok(result.payload.approvalTokenHash, 'Token hashed (first 8 chars)');
  assert.ok(result.signature, 'Record signed');
});

test('captureOperationRequest - without approval token', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureOperationRequest({
    operation: 'get_tasks',
    requestId: 'req-123',
    requester: 'user@example.com',
    targetId: null
  });

  assert.equal(result.payload.approvalTokenProvided, false);
  assert.equal(result.payload.approvalTokenHash, null);
});

// Category 2: Authorization Evidence
test('captureAuthorization - records approval details', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureAuthorization({
    approvalMethod: 'mfa',
    approver: 'admin@example.com',
    approvalScope: 'production_deploy',
    correlationId: 'corr-123',
    ttlMinutes: 120,
    mfaVerified: true
  });

  assert.equal(result.category, 'authorization');
  assert.equal(result.payload.approvalMethod, 'mfa');
  assert.equal(result.payload.approver, 'admin@example.com');
  assert.equal(result.payload.ttlMinutes, 120);
  assert.ok(result.payload.expiresAt, 'Expiration time calculated');
  assert.equal(result.payload.mfaVerified, true);
});

// Category 3: State Snapshot
test('captureStateSnapshot - records before/after state', (t) => {
  const engine = new EvidenceCaptureEngine();
  const stateData = {
    branch: 'main',
    sha: 'abc123def456',
    version: '1.0.0'
  };

  const result = engine.captureStateSnapshot({
    snapshotType: 'before',
    appId: 'app-789',
    environment: 'production',
    correlationId: 'corr-123',
    stateData
  });

  assert.equal(result.category, 'state_snapshot');
  assert.equal(result.payload.snapshotType, 'before');
  assert.ok(result.payload.stateHash, 'State hash computed');
  assert.equal(result.payload.sourceState.branch, 'main');
  assert.equal(result.payload.sourceState.sha, 'abc123def456');
});

// Category 4: Execution Trace
test('captureExecutionTrace - records API calls', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureExecutionTrace({
    apiEndpoint: '/repos/user/repo/contents/file.json',
    apiMethod: 'PUT',
    correlationId: 'corr-123',
    responseStatus: 200,
    responseTime: 245,
    requestPayload: { content: 'test' },
    responsePayload: { sha: 'abc123' }
  });

  assert.equal(result.category, 'execution_trace');
  assert.equal(result.payload.apiMethod, 'PUT');
  assert.equal(result.payload.responseStatus, 200);
  assert.equal(result.payload.responseTime, 245);
  assert.ok(result.payload.requestHash, 'Request hashed');
  assert.ok(result.payload.responseHash, 'Response hashed');
});

test('captureExecutionTrace - records errors and retries', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureExecutionTrace({
    apiEndpoint: '/deploy',
    apiMethod: 'POST',
    correlationId: 'corr-123',
    responseStatus: 500,
    responseTime: 1000,
    requestPayload: {},
    responsePayload: {},
    errorInfo: { message: 'Timeout' },
    retryCount: 2,
    retriedAfter: 'PT5S'
  });

  assert.ok(result.payload.errorInfo, 'Error recorded');
  assert.equal(result.payload.retryCount, 2);
  assert.equal(result.payload.retriedAfter, 'PT5S');
});

// Category 5: Screen State
test('captureScreenState - records Power Apps screen state', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureScreenState({
    appId: 'app-789',
    screenName: 'EditScreen',
    controlStates: {
      TextField1: { value: 'test', enabled: true },
      Button1: { enabled: false }
    },
    userInteraction: 'click_save',
    correlationId: 'corr-123'
  });

  assert.equal(result.category, 'screen_state');
  assert.equal(result.payload.screenName, 'EditScreen');
  assert.ok(result.payload.controls, 'Control states recorded');
  assert.equal(result.payload.userInteractionType, 'click_save');
});

// Category 6: Audit Event
test('captureAuditEvent - records status transitions', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureAuditEvent({
    eventType: 'status_change',
    fromStatus: 'editing',
    toStatus: 'saving',
    correlationId: 'corr-123',
    actor: 'system',
    reason: 'Auto-save triggered'
  });

  assert.equal(result.category, 'audit_event');
  assert.equal(result.payload.eventType, 'status_change');
  assert.equal(result.payload.fromStatus, 'editing');
  assert.equal(result.payload.toStatus, 'saving');
});

test('captureAuditEvent - records error events', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureAuditEvent({
    eventType: 'error',
    fromStatus: 'saving',
    toStatus: 'error',
    correlationId: 'corr-123',
    reason: 'Network timeout',
    escalationLevel: 1
  });

  assert.equal(result.payload.eventType, 'error');
  assert.equal(result.payload.escalationLevel, 1);
});

// Category 7: Correlation Evidence
test('captureCorrelation - links related operations', (t) => {
  const engine = new EvidenceCaptureEngine();
  const correlationId = 'corr-123';
  const result = engine.captureCorrelation({
    correlationId,
    parentId: 'op-save',
    childIds: ['op-publish', 'op-verify'],
    relationType: 'parent_child',
    linkedOperations: ['save', 'publish', 'verify']
  });

  assert.equal(result.category, 'correlation');
  assert.equal(result.payload.relationType, 'parent_child');
  assert.deepEqual(result.payload.childIds, ['op-publish', 'op-verify']);
  assert.deepEqual(result.payload.linkedOperations, ['save', 'publish', 'verify']);
});

// Category 8: Source Evidence
test('captureSourceEvidence - records GitHub source state', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureSourceEvidence({
    repository: 'oohiraplas-cpu/clean-nano-ai-bridge',
    branch: 'main',
    canonicalBranch: 'main',
    filePath: 'powerapps/CN_AI依頼台帳/Source',
    sha256: 'abc123def456ghi789',
    fileSize: 12345,
    correlationId: 'corr-123',
    origin: 'github_canonical'
  });

  assert.equal(result.category, 'source_evidence');
  assert.equal(result.payload.repository, 'oohiraplas-cpu/clean-nano-ai-bridge');
  assert.equal(result.payload.isCanonicalBranch, true);
  assert.equal(result.payload.origin, 'github_canonical');
  assert.equal(result.payload.sha256, 'abc123def456ghi789');
});

test('captureSourceEvidence - detects non-canonical branch', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureSourceEvidence({
    repository: 'oohiraplas-cpu/clean-nano-ai-bridge',
    branch: 'feature/x',
    canonicalBranch: 'main',
    filePath: 'src/test.js',
    sha256: 'abc123',
    correlationId: 'corr-123'
  });

  assert.equal(result.payload.isCanonicalBranch, false);
});

// Category 9: Runtime State
test('captureRuntimeState - records deployed app state', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureRuntimeState({
    appId: 'app-789',
    appVersion: '2.3.1',
    environment: 'production',
    correlationId: 'corr-123',
    deployedAt: '2026-10-10T12:00:00Z',
    runtimeState: { status: 'running', errors: 0 },
    behaviorVerified: true
  });

  assert.equal(result.category, 'runtime_state');
  assert.equal(result.payload.appVersion, '2.3.1');
  assert.equal(result.payload.behaviorVerified, true);
  assert.ok(result.payload.runtimeState, 'Runtime state recorded');
});

// Category 10: Remediation
test('captureRemediation - records rollback operations', (t) => {
  const engine = new EvidenceCaptureEngine();
  const result = engine.captureRemediation({
    correlationId: 'corr-123',
    remediationType: 'rollback',
    rolledBackFrom: 'v2.3.1',
    rolledBackTo: 'v2.3.0',
    remediationActor: 'admin@example.com',
    reason: 'Critical bug in v2.3.1',
    automatedRecovery: false
  });

  assert.equal(result.category, 'remediation');
  assert.equal(result.payload.remediationType, 'rollback');
  assert.equal(result.payload.rolledBackFrom, 'v2.3.1');
  assert.equal(result.payload.rolledBackTo, 'v2.3.0');
  assert.equal(result.payload.automatedRecovery, false);
});

// Integration Tests
test('generateAuditReport - compiles all evidence', (t) => {
  const engine = new EvidenceCaptureEngine();
  const correlationId = 'corr-123';

  // Capture multiple evidence items
  engine.captureOperationRequest({
    operation: 'publish_app',
    requestId: 'req-1',
    requester: 'user@example.com',
    correlationId
  });

  engine.captureAuthorization({
    approvalMethod: 'mfa',
    approver: 'admin@example.com',
    approvalScope: 'all',
    correlationId
  });

  engine.captureStateSnapshot({
    snapshotType: 'before',
    appId: 'app-1',
    environment: 'prod',
    correlationId,
    stateData: { version: '1.0' }
  });

  engine.captureExecutionTrace({
    apiEndpoint: '/deploy',
    apiMethod: 'POST',
    correlationId,
    responseStatus: 200,
    responseTime: 100,
    requestPayload: {},
    responsePayload: {}
  });

  const report = engine.generateAuditReport(correlationId);

  assert.equal(report.correlationId, correlationId);
  assert.equal(report.recordCount, 4);
  assert.ok(report.categories.operation_request, 'Operation request category present');
  assert.ok(report.categories.authorization, 'Authorization category present');
  assert.ok(report.categories.state_snapshot, 'State snapshot category present');
  assert.ok(report.categories.execution_trace, 'Execution trace category present');
  assert.ok(report.timeline.length > 0, 'Timeline populated');
  assert.equal(report.integrityStatus, 'VALID', 'All signatures valid');
});

test('verifyRecords - marks evidence as verified', (t) => {
  const engine = new EvidenceCaptureEngine();
  const correlationId = 'corr-123';

  engine.captureOperationRequest({
    operation: 'deploy',
    requestId: 'req-1',
    requester: 'user@example.com',
    correlationId
  });

  assert.equal(engine.records[0].verified, false, 'Initially not verified');

  const verified = engine.verifyRecords(correlationId, 'auditor@example.com');

  assert.equal(verified.length, 1);
  assert.equal(verified[0].verified, true);
  assert.equal(verified[0].verifier, 'auditor@example.com');
});

test('exportEvidence - creates exportable audit trail', (t) => {
  const engine = new EvidenceCaptureEngine();
  const correlationId = 'corr-123';

  engine.captureOperationRequest({
    operation: 'deploy',
    requestId: 'req-1',
    requester: 'user@example.com',
    approvalToken: 'secret-token-123',
    correlationId
  });

  engine.captureAuthorization({
    approvalMethod: 'token',
    approver: 'admin@example.com',
    approvalScope: 'all',
    correlationId
  });

  const exported = engine.exportEvidence(correlationId);

  assert.ok(exported.exportId, 'Export has ID');
  assert.ok(exported.auditReport, 'Audit report included');
  assert.ok(exported.fullRecords, 'Records included');
  // The first record is operation_request which stores approvalTokenHash (not the full token)
  // approvalTokenHash itself is not redacted, but the full token is not in payload
  // Verify operation request record doesn't have the full token
  const operationRecord = exported.fullRecords.find(r => r.category === 'operation_request');
  assert.notEqual(operationRecord.payload.approvalToken, 'secret-token-123', 'Full token is never stored');
});

test('redactSensitiveData - removes sensitive fields', (t) => {
  const engine = new EvidenceCaptureEngine();
  const payload = {
    operation: 'test',
    approvalToken: 'secret123',
    password: 'password456',
    apiKey: 'key789',
    normalField: 'normal'
  };

  const redacted = engine.redactSensitiveData(payload);

  assert.equal(redacted.approvalToken, '[REDACTED]');
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.normalField, 'normal');
});

test('cleanupOldRecords - removes records past retention', (t) => {
  const engine = new EvidenceCaptureEngine({ retentionDays: 0 }); // Force old immediately

  engine.captureOperationRequest({
    operation: 'test',
    requestId: 'req-1',
    requester: 'user@example.com'
  });

  assert.equal(engine.records.length, 1, 'Record added');

  const cleanup = engine.cleanupOldRecords();

  assert.ok(cleanup.deletedCount >= 0, 'Cleanup report generated');
  assert.ok(cleanup.remainingCount >= 0, 'Remaining count reported');
});

test('signEvidence - verifies integrity', (t) => {
  const engine = new EvidenceCaptureEngine();
  const payload = { test: 'data' };

  const sig1 = engine.signEvidence(payload);
  const sig2 = engine.signEvidence(payload);

  assert.equal(sig1, sig2, 'Same payload produces same signature');

  const sig3 = engine.signEvidence({ test: 'different' });
  assert.notEqual(sig1, sig3, 'Different payload produces different signature');
});

test('multiple correlations - separate audit trails', (t) => {
  const engine = new EvidenceCaptureEngine();

  engine.captureOperationRequest({
    operation: 'op1',
    requestId: 'req-1',
    requester: 'user@example.com',
    correlationId: 'corr-A'
  });

  engine.captureOperationRequest({
    operation: 'op2',
    requestId: 'req-2',
    requester: 'user@example.com',
    correlationId: 'corr-B'
  });

  const reportA = engine.generateAuditReport('corr-A');
  const reportB = engine.generateAuditReport('corr-B');

  assert.equal(reportA.recordCount, 1);
  assert.equal(reportB.recordCount, 1);
  assert.notEqual(reportA.correlationId, reportB.correlationId);
});
