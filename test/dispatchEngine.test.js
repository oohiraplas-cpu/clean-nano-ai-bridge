const test = require('node:test');
const assert = require('node:assert');
const { DispatchEngine } = require('../src/dispatchEngine');
const { ProhibitedOperationsEngine } = require('../src/prohibitedOperationsEngine');
const { DoneEngine } = require('../src/doneEngine');
const { EvidenceCaptureEngine } = require('../src/evidenceCaptureEngine');

test('DispatchEngine - initialization', (t) => {
  const engine = new DispatchEngine();
  assert.ok(engine, 'Engine instantiated');
  assert.ok(Array.isArray(engine.dispatchLog), 'Dispatch log initialized');
});

// Test 1: Operation blocked by prohibited operations gate
test('dispatch - blocks prohibited operation (production deploy without approval)', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'publish_powerapps_app',
    id: 'req-1',
    requester: 'user@example.com',
    approvalToken: null,
    environment: 'production'
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'BLOCKED', 'Operation blocked');
  assert.equal(decision.allowed, false);
  assert.ok(decision.prohibitionCheck.blocked, 'Prohibition check blocked');
  assert.ok(decision.verdicts.includes('PROHIBITED_OPERATION'));
  assert.ok(decision.reasoning.gatesBlocked.includes('prohibited_operations'));
  assert.ok(decision.nextSteps.some(s => s.includes('administrator')));
});

// Test 2: Operation blocked by deletion without approval
test('dispatch - blocks deletion without approval', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'delete_app',
    id: 'req-2',
    requester: 'user@example.com',
    approvalToken: null,
    targetName: 'CriticalApp'
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'BLOCKED');
  assert.ok(decision.prohibitionCheck.violations.includes('deletion'));
});

// Test 3: Operation approved with valid approval token
test('dispatch - approves operation with valid approval token', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'publish_powerapps_app',
    id: 'req-3',
    requester: 'user@example.com',
    approvalToken: 'valid-approval-token-abc123def456',
    environment: 'production'
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'APPROVED', 'Operation approved');
  assert.equal(decision.allowed, true);
  assert.ok(decision.readyToExecute, 'Ready to execute');
  assert.ok(decision.reasoning.gatesPassed.includes('prohibited_operations'));
});

// Test 4: Multiple violations detected
test('dispatch - detects multiple violations', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'delete_app',
    id: 'req-4',
    requester: 'user@example.com',
    approvalToken: null,
    environment: 'production',
    targetBranch: 'main',
    targetName: 'CriticalApp',
    paramKeys: ['api_key', 'password']
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'BLOCKED');
  assert.ok(decision.prohibitionCheck.violations.length >= 2, 'Multiple violations detected');
});

// Test 5: Evidence capture for approved operation
test('dispatch - captures evidence for approved operation', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const correlationId = 'corr-123';
  const decision = dispatcher.dispatch({
    correlationId,
    operation: 'save_powerapps_app',
    id: 'req-5',
    requester: 'user@example.com',
    targetId: 'app-123'
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'APPROVED');
  assert.equal(decision.correlationId, correlationId);
  assert.ok(decision.decisionLog.length > 0, 'Decision log populated');
  assert.ok(decision.evidenceReport, 'Evidence report generated');
});

// Test 6: Completion assessment blocks incomplete prerequisites
test('dispatch - blocks operation with incomplete prerequisites', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const doneEngine = new DoneEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'publish_powerapps_app',
    id: 'req-6',
    requester: 'user@example.com',
    requiresCompletionAssessment: true,
    blockOnIncomplete: true,
    inputState: { sha: 'abc123' },
    runtimeState: { sha: 'def456' }, // Mismatch - fails state check
    operationLog: [],
    evidence: {}
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: doneEngine,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'BLOCKED');
  assert.ok(decision.completionAssessment, 'Completion assessment performed');
  assert.ok(decision.verdicts.includes('INCOMPLETE_PREREQUISITES'));
});

// Test 7: Prerequisites evaluation
test('dispatch - evaluates prerequisites', (t) => {
  const dispatcher = new DispatchEngine();

  const result = dispatcher.evaluatePrerequisites(
    ['save_app', 'verify_source', 'test_app'],
    ['save_app', 'verify_source']
  );

  assert.equal(result.allMet, false);
  assert.deepEqual(result.unmet, ['test_app']);
  assert.deepEqual(result.met, ['save_app', 'verify_source']);
  assert.equal(result.status, 'waiting');
});

test('dispatch - all prerequisites met', (t) => {
  const dispatcher = new DispatchEngine();

  const result = dispatcher.evaluatePrerequisites(
    ['save_app', 'verify_source'],
    ['save_app', 'verify_source', 'test_app', 'deploy_app']
  );

  assert.equal(result.allMet, true);
  assert.deepEqual(result.unmet, []);
  assert.equal(result.status, 'ready');
});

// Test 8: Next actions determination
test('dispatch - determines next actions for blocked operation', (t) => {
  const dispatcher = new DispatchEngine();

  const decision = {
    allowed: false,
    verdict: 'BLOCKED',
    prohibitionCheck: {
      violations: ['deletion'],
      reasons: ['Deletion operations require explicit approval'],
      requiresApprovalCategories: ['deletion']
    }
  };

  const actions = dispatcher.determineNextActions(decision, {
    operation: 'delete_app'
  });

  assert.ok(actions.length > 0);
  assert.ok(actions.some(a => a.type === 'inform_user'));
  assert.ok(actions.some(a => a.type === 'request_approval'));
});

test('dispatch - determines next actions for approved operation', (t) => {
  const dispatcher = new DispatchEngine();

  const decision = {
    allowed: true,
    verdict: 'APPROVED',
    readyToExecute: true,
    correlationId: 'corr-123'
  };

  const actions = dispatcher.determineNextActions(decision, {
    operation: 'save_app',
    approvalToken: 'token-123'
  });

  assert.ok(actions.some(a => a.type === 'execute_operation'));
  const execAction = actions.find(a => a.type === 'execute_operation');
  assert.equal(execAction.operation, 'save_app');
});

// Test 9: Comprehensive dispatch report
test('dispatch - generates comprehensive report', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'save_powerapps_app',
    id: 'req-9',
    requester: 'user@example.com',
    targetId: 'app-123'
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  const report = dispatcher.generateDispatchReport(decision);

  assert.ok(report.dispatchId);
  assert.ok(report.timestamp);
  assert.equal(report.verdict, 'APPROVED');
  assert.ok(report.reasoning);
  assert.ok(report.decisionLog);
  assert.ok(report.gatesPassed);
  assert.ok(report.nextSteps);
});

// Test 10: Dispatch with all gates (prohibition + completion)
test('dispatch - passes both prohibition and completion gates', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const doneEngine = new DoneEngine();
  const evidencer = new EvidenceCaptureEngine();

  const now = Date.now();
  const decision = dispatcher.dispatch({
    operation: 'save_powerapps_app',
    id: 'req-10',
    requester: 'user@example.com',
    requiresCompletionAssessment: true,
    blockOnIncomplete: false, // Allow incomplete
    inputState: { appId: 'app-123', sha: 'abc123' },
    runtimeState: { appId: 'app-123', sha: 'abc123' },
    operationLog: [
      { operation: 'save', timestamp: new Date(now).toISOString(), status: 'success' },
      { operation: 'publish', timestamp: new Date(now + 1000).toISOString(), status: 'success' },
      { operation: 'reread', timestamp: new Date(now + 2000).toISOString(), status: 'success' }
    ],
    evidence: {},
    targetBranch: 'dev', // Use dev branch to avoid prohibition
    environment: 'test' // Use test environment to avoid production prohibition
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: doneEngine,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'APPROVED');
  assert.ok(decision.prohibitionCheck, 'Prohibition check completed');
  assert.ok(decision.completionAssessment, 'Completion assessment completed');
  assert.ok(decision.reasoning.gatesPassed.includes('prohibited_operations'));
});

// Test 11: Always-blocked operations (secrets, external sharing, data export)
test('dispatch - always blocks secret modification regardless of approval', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'update_connection',
    id: 'req-11',
    requester: 'user@example.com',
    approvalToken: 'valid-token-xyz',
    paramKeys: ['password', 'api_key']
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'BLOCKED', 'Secret modification blocked even with approval');
  assert.ok(decision.prohibitionCheck.violations.includes('secret_modification'));
});

test('dispatch - always blocks external sharing regardless of approval', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'share_app',
    id: 'req-12',
    requester: 'user@example.com',
    approvalToken: 'valid-token-xyz',
    targetScope: 'public',
    currentScope: 'internal'
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'BLOCKED');
  assert.ok(decision.prohibitionCheck.violations.includes('external_sharing'));
});

test('dispatch - always blocks data export regardless of approval', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'export_data',
    id: 'req-13',
    requester: 'user@example.com',
    approvalToken: 'valid-token-xyz'
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.equal(decision.verdict, 'BLOCKED');
  assert.ok(decision.prohibitionCheck.violations.includes('data_backup_export'));
});

// Test 12: Decision log tracks all phases
test('dispatch - decision log tracks all phases', (t) => {
  const dispatcher = new DispatchEngine();
  const prohibitioner = new ProhibitedOperationsEngine();
  const evidencer = new EvidenceCaptureEngine();

  const decision = dispatcher.dispatch({
    operation: 'save_app',
    id: 'req-14',
    requester: 'user@example.com',
    approvalToken: 'token-123'
  }, {
    prohibitionEngine: prohibitioner,
    doneEngine: null,
    evidenceEngine: evidencer
  });

  assert.ok(decision.decisionLog.length >= 2, 'Multiple phases in decision log');
  const phases = decision.decisionLog.map(d => d.phase);
  assert.ok(phases.includes('evidence'));
  assert.ok(phases.includes('prohibited_operations'));
  assert.ok(phases.includes('dispatch'));
});
