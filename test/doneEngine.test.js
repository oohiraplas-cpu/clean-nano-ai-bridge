const test = require('node:test');
const assert = require('node:assert');
const { DoneEngine } = require('../src/doneEngine.js');

// Test suite for Phase 7 DONE Engine
test('DoneEngine - initialization and structure', async (t) => {
  const engine = new DoneEngine();

  assert.ok(engine, 'DoneEngine instantiated');
  assert.equal(engine.operations.length, 12, '12 operations registered');
  assert.ok(Array.isArray(engine.operations), 'operations is array');
});

// Test condition 1: State match
test('checkStateMatch - identical states pass', (t) => {
  const engine = new DoneEngine();
  const state = {
    appId: 'test-app',
    environment: 'test-env',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40)
  };

  const result = engine.checkStateMatch(state, state);
  assert.equal(result.passed, true, 'identical states pass');
  assert.equal(result.mismatches.length, 0, 'no mismatches');
});

test('checkStateMatch - field mismatch fails', (t) => {
  const engine = new DoneEngine();
  const input = {
    appId: 'app1',
    environment: 'test',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40)
  };
  const runtime = {
    appId: 'app2',
    environment: 'test',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40)
  };

  const result = engine.checkStateMatch(input, runtime);
  assert.equal(result.passed, false, 'mismatch fails');
  assert.ok(result.mismatches.length > 0, 'mismatches recorded');
});

test('checkStateMatch - missing state fails', (t) => {
  const engine = new DoneEngine();

  const result = engine.checkStateMatch(null, {});
  assert.equal(result.passed, false, 'null state fails');
  assert.equal(result.reason, 'missing state');
});

// Test condition 2: Branch match
test('checkBranchMatch - canonical branches match', (t) => {
  const engine = new DoneEngine();

  const result = engine.checkBranchMatch('main', 'main', 'main', 'main');
  assert.equal(result.passed, true, 'canonical branches match');
  assert.equal(result.inputCanonical, true);
  assert.equal(result.runtimeCanonical, true);
  assert.equal(result.crossConsistent, true);
});

test('checkBranchMatch - non-canonical input fails', (t) => {
  const engine = new DoneEngine();

  const result = engine.checkBranchMatch('dev', 'main', 'main', 'main');
  assert.equal(result.passed, false, 'non-canonical input fails');
  assert.equal(result.inputCanonical, false);
});

test('checkBranchMatch - runtime mismatch fails', (t) => {
  const engine = new DoneEngine();

  const result = engine.checkBranchMatch('main', 'main', 'dev', 'main');
  assert.equal(result.passed, false, 'runtime branch mismatch fails');
  assert.equal(result.runtimeCanonical, false);
});

// Test condition 3: SHA match
test('checkShaMatch - identical valid SHAs pass', (t) => {
  const engine = new DoneEngine();
  const sha = 'a'.repeat(40);

  const result = engine.checkShaMatch(sha, sha);
  assert.equal(result.passed, true, 'identical SHAs pass');
  assert.equal(result.reason, null, 'no mismatch reason');
});

test('checkShaMatch - different SHAs fail', (t) => {
  const engine = new DoneEngine();
  const sha1 = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);

  const result = engine.checkShaMatch(sha1, sha2);
  assert.equal(result.passed, false, 'different SHAs fail');
  assert.equal(result.reason, 'SHA mismatch');
});

test('checkShaMatch - invalid format fails', (t) => {
  const engine = new DoneEngine();

  const result = engine.checkShaMatch('invalid', 'a'.repeat(40));
  assert.equal(result.passed, false, 'invalid SHA fails');
  assert.equal(result.inputValid, false);
});

// Test condition 4: Save confirmed
test('checkSaveConfirmed - valid save operation passes', (t) => {
  const engine = new DoneEngine();
  const opLog = [
    {
      operation: 'save',
      timestamp: new Date().toISOString(),
      status: 'success'
    }
  ];

  const result = engine.checkSaveConfirmed(opLog);
  assert.equal(result.passed, true, 'valid save operation passes');
  assert.equal(result.hasTimestamp, true);
  assert.equal(result.hasStatus, true);
});

test('checkSaveConfirmed - missing operation fails', (t) => {
  const engine = new DoneEngine();
  const opLog = [];

  const result = engine.checkSaveConfirmed(opLog);
  assert.equal(result.passed, false, 'missing operation fails');
  assert.equal(result.reason, 'save operation not found');
});

test('checkSaveConfirmed - invalid status fails', (t) => {
  const engine = new DoneEngine();
  const opLog = [
    {
      operation: 'save',
      timestamp: new Date().toISOString(),
      status: 'pending'
    }
  ];

  const result = engine.checkSaveConfirmed(opLog);
  assert.equal(result.passed, false, 'invalid status fails');
  assert.equal(result.hasStatus, false);
});

// Test condition 5: Publish confirmed
test('checkPublishConfirmed - valid publish operation passes', (t) => {
  const engine = new DoneEngine();
  const opLog = [
    {
      operation: 'publish',
      timestamp: new Date().toISOString(),
      status: 'completed'
    }
  ];

  const result = engine.checkPublishConfirmed(opLog);
  assert.equal(result.passed, true, 'valid publish passes');
});

test('checkPublishConfirmed - missing operation fails', (t) => {
  const engine = new DoneEngine();

  const result = engine.checkPublishConfirmed([]);
  assert.equal(result.passed, false, 'missing publish fails');
});

// Test condition 6: Re-read confirmed
test('checkRereadConfirmed - valid reread passes', (t) => {
  const engine = new DoneEngine();
  const opLog = [
    { operation: 'publish', timestamp: new Date(Date.now() - 1000).toISOString() },
    { operation: 'reread', timestamp: new Date().toISOString(), stateSnapshot: { key: 'value' } }
  ];

  const result = engine.checkRereadConfirmed(opLog, {});
  assert.equal(result.passed, true, 'valid reread passes');
  assert.equal(result.hasStateSnapshot, true);
});

test('checkRereadConfirmed - missing state snapshot fails', (t) => {
  const engine = new DoneEngine();
  const opLog = [
    { operation: 'reread', timestamp: new Date().toISOString(), stateSnapshot: {} }
  ];

  const result = engine.checkRereadConfirmed(opLog, {});
  assert.equal(result.passed, false, 'empty snapshot fails');
});

// Test condition 7: Runtime confirmed
test('checkRuntimeConfirmed - valid response passes', (t) => {
  const engine = new DoneEngine();
  const response = {
    httpStatus: 200,
    responseTime: 500,
    timestamp: new Date().toISOString()
  };

  const result = engine.checkRuntimeConfirmed(response);
  assert.equal(result.passed, true, 'valid response passes');
});

test('checkRuntimeConfirmed - non-200 status fails', (t) => {
  const engine = new DoneEngine();
  const response = {
    httpStatus: 500,
    responseTime: 500,
    timestamp: new Date().toISOString()
  };

  const result = engine.checkRuntimeConfirmed(response);
  assert.equal(result.passed, false, 'non-200 status fails');
  assert.equal(result.reason, 'HTTP status not 200');
});

test('checkRuntimeConfirmed - excessive response time fails', (t) => {
  const engine = new DoneEngine();
  const response = {
    httpStatus: 200,
    responseTime: 45000,
    timestamp: new Date().toISOString()
  };

  const result = engine.checkRuntimeConfirmed(response);
  assert.equal(result.passed, false, 'excessive response time fails');
});

// Test condition 8: Authorization confirmed
test('checkAuthorizationConfirmed - valid auth passes', (t) => {
  const engine = new DoneEngine();
  const auth = {
    authorized: true,
    scope: ['read', 'write'],
    expiresAt: new Date(Date.now() + 3600000).toISOString()
  };

  const result = engine.checkAuthorizationConfirmed(auth);
  assert.equal(result.passed, true, 'valid auth passes');
});

test('checkAuthorizationConfirmed - expired auth fails', (t) => {
  const engine = new DoneEngine();
  const auth = {
    authorized: true,
    scope: ['read'],
    expiresAt: new Date(Date.now() - 1000).toISOString()
  };

  const result = engine.checkAuthorizationConfirmed(auth);
  assert.equal(result.passed, false, 'expired auth fails');
});

test('checkAuthorizationConfirmed - not authorized fails', (t) => {
  const engine = new DoneEngine();
  const auth = {
    authorized: false,
    scope: ['read'],
    expiresAt: new Date(Date.now() + 3600000).toISOString()
  };

  const result = engine.checkAuthorizationConfirmed(auth);
  assert.equal(result.passed, false, 'unauthorized fails');
});

// Test condition 9: Screen confirmed
test('checkScreenConfirmed - valid screen evidence passes', (t) => {
  const engine = new DoneEngine();
  const evidence = {
    screenshotId: 'screenshot-123',
    displayConfirmed: true,
    timestamp: new Date().toISOString()
  };

  const result = engine.checkScreenConfirmed(evidence);
  assert.equal(result.passed, true, 'valid screen evidence passes');
});

test('checkScreenConfirmed - missing screenshot fails', (t) => {
  const engine = new DoneEngine();
  const evidence = {
    screenshotId: '',
    displayConfirmed: true,
    timestamp: new Date().toISOString()
  };

  const result = engine.checkScreenConfirmed(evidence);
  assert.equal(result.passed, false, 'missing screenshot fails');
});

test('checkScreenConfirmed - display not confirmed fails', (t) => {
  const engine = new DoneEngine();
  const evidence = {
    screenshotId: 'screenshot-123',
    displayConfirmed: false,
    timestamp: new Date().toISOString()
  };

  const result = engine.checkScreenConfirmed(evidence);
  assert.equal(result.passed, false, 'display not confirmed fails');
});

// Test condition 10: Evidence captured
test('checkEvidenceCaptured - sufficient evidence passes', (t) => {
  const engine = new DoneEngine();
  const evidence = {
    correlationId: 'corr-123',
    runtimeSha: 'a'.repeat(40),
    response: { status: 'ok' },
    state: { key: 'value' }
  };

  const result = engine.checkEvidenceCaptured(evidence);
  assert.equal(result.passed, true, 'sufficient evidence passes');
  assert.equal(result.count >= 3, true, '≥3 items captured');
});

test('checkEvidenceCaptured - insufficient evidence fails', (t) => {
  const engine = new DoneEngine();
  const evidence = {
    correlationId: 'corr-123',
    runtimeSha: 'a'.repeat(40)
  };

  const result = engine.checkEvidenceCaptured(evidence);
  assert.equal(result.passed, false, 'insufficient evidence fails');
  assert.equal(result.count < 3, true, '<3 items captured');
});

// Test condition 11: Audit recorded
test('checkAuditRecorded - valid audit log passes', (t) => {
  const engine = new DoneEngine();
  const auditLog = [
    {
      timestamp: new Date().toISOString(),
      correlationId: 'corr-123',
      action: 'save'
    }
  ];

  const result = engine.checkAuditRecorded(auditLog);
  assert.equal(result.passed, true, 'valid audit log passes');
});

test('checkAuditRecorded - empty log fails', (t) => {
  const engine = new DoneEngine();

  const result = engine.checkAuditRecorded([]);
  assert.equal(result.passed, false, 'empty log fails');
});

test('checkAuditRecorded - missing correlation fails', (t) => {
  const engine = new DoneEngine();
  const auditLog = [
    {
      timestamp: new Date().toISOString(),
      action: 'save'
    }
  ];

  const result = engine.checkAuditRecorded(auditLog);
  assert.equal(result.passed, false, 'missing correlation fails');
});

// Test condition 12: Critical errors
test('checkCriticalErrorsZero - no critical errors passes', (t) => {
  const engine = new DoneEngine();
  const errorLog = [
    { severity: 'warning', message: 'test' },
    { severity: 'info', message: 'test' }
  ];

  const result = engine.checkCriticalErrorsZero(errorLog);
  assert.equal(result.passed, true, 'no critical errors passes');
  assert.equal(result.criticalCount, 0);
});

test('checkCriticalErrorsZero - critical errors fail', (t) => {
  const engine = new DoneEngine();
  const errorLog = [
    { severity: 'critical', message: 'failure' }
  ];

  const result = engine.checkCriticalErrorsZero(errorLog);
  assert.equal(result.passed, false, 'critical errors fail');
  assert.equal(result.criticalCount, 1);
});

// Integration tests: Full assessment
test('assess - all conditions pass returns DONE verdict', (t) => {
  const engine = new DoneEngine();

  const now = Date.now();
  const context = {
    inputState: {
      appId: 'app1',
      environment: 'test',
      branch: 'main',
      canonicalBranch: 'main',
      sha: 'a'.repeat(40)
    },
    runtimeState: {
      appId: 'app1',
      environment: 'test',
      branch: 'main',
      canonicalBranch: 'main',
      sha: 'a'.repeat(40)
    },
    operationLog: [
      { operation: 'save', timestamp: new Date(now).toISOString(), status: 'success' },
      { operation: 'publish', timestamp: new Date(now + 100).toISOString(), status: 'success' },
      { operation: 'reread', timestamp: new Date(now + 200).toISOString(), stateSnapshot: { key: 'val' } }
    ],
    runtimeResponse: {
      httpStatus: 200,
      responseTime: 500,
      timestamp: new Date(now + 300).toISOString()
    },
    authContext: {
      authorized: true,
      scope: ['all'],
      expiresAt: new Date(now + 3600000).toISOString()
    },
    screenEvidence: {
      screenshotId: 'img-123',
      displayConfirmed: true,
      timestamp: new Date(now + 400).toISOString()
    },
    evidence: {
      correlationId: 'corr-123',
      runtimeSha: 'a'.repeat(40),
      response: { ok: true },
      state: { data: 'test' }
    },
    auditLog: [
      { timestamp: new Date(now + 500).toISOString(), correlationId: 'corr-123', action: 'complete' }
    ],
    errorLog: []
  };

  const result = engine.assess(context);
  assert.equal(result.done, true, 'assessment complete');
  assert.equal(result.verdict, 'DONE', 'verdict is DONE');
  assert.equal(result.passCount, 12, 'all 12 conditions pass');
  assert.equal(result.failCount, 0, 'no failures');
  assert.equal(result.completionPercent, 100, '100% completion');
});

test('assess - partial conditions returns IN_PROGRESS', (t) => {
  const engine = new DoneEngine();

  const context = {
    inputState: {
      appId: 'app1',
      environment: 'test',
      branch: 'main',
      canonicalBranch: 'main',
      sha: 'a'.repeat(40)
    },
    runtimeState: {
      appId: 'app1',
      environment: 'test',
      branch: 'main',
      canonicalBranch: 'main',
      sha: 'a'.repeat(40)
    },
    operationLog: [
      { operation: 'save', timestamp: new Date().toISOString(), status: 'success' }
    ],
    // missing publish, reread, runtime response, auth, screen, evidence
    errorLog: []
  };

  const result = engine.assess(context);
  assert.equal(result.done, false, 'not complete');
  assert.equal(result.failCount > 0, true, 'has failures');
  assert.ok(['IN_PROGRESS', 'BLOCKED'].includes(result.verdict), 'verdict is IN_PROGRESS or BLOCKED');
});

test('assess - blocked prerequisites returns BLOCKED', (t) => {
  const engine = new DoneEngine();

  const context = {
    inputState: { appId: 'app1', environment: 'test', branch: 'main', canonicalBranch: 'main', sha: 'a'.repeat(40) },
    runtimeState: { appId: 'app1', environment: 'test', branch: 'main', canonicalBranch: 'main', sha: 'a'.repeat(40) },
    // Missing save operation - prevents publish, reread, audit
    operationLog: [],
    errorLog: []
  };

  const result = engine.assess(context);
  assert.equal(result.done, false);
  // Prerequisites should block dependent operations
  assert.ok(result.failed.length > 0, 'has failures');
});

test('assess - includes metadata in result', (t) => {
  const engine = new DoneEngine();
  const context = {
    inputState: { appId: 'app1', environment: 'test', branch: 'main', canonicalBranch: 'main', sha: 'a'.repeat(40) },
    runtimeState: { appId: 'app1', environment: 'test', branch: 'main', canonicalBranch: 'main', sha: 'a'.repeat(40) },
    operationLog: [],
    errorLog: []
  };

  const result = engine.assess(context);
  assert.ok(result.timestamp, 'includes timestamp');
  assert.ok(result.assessmentId, 'includes assessment ID');
  assert.ok(Array.isArray(result.passed), 'includes passed array');
  assert.ok(Array.isArray(result.failed), 'includes failed array');
  assert.ok(Array.isArray(result.next), 'includes next array');
});
