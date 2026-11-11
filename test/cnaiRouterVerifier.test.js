'use strict';
// Independent Verifier tests. Deliberately exercised against cnaiRouter's PUBLIC
// getStatus/getAuditTrail/getCheckpoint output only — this must catch a fabricated
// COMPLETED even if cnaiRouter's own internal bookkeeping is never consulted here.
const assert = require('node:assert/strict');
const test = require('node:test');
const cnaiRouter = require('../src/cnaiRouter');
const { verifyRouterRecord } = require('../src/cnaiRouterVerifier');

async function runAndCollect(input, adapters) {
  const state = cnaiRouter.createRouterState();
  const result = await cnaiRouter.routeRequest(state, input, adapters);
  return {
    state,
    result,
    snapshot: cnaiRouter.getStatus(state, result.requestId),
    audit: cnaiRouter.getAuditTrail(state, result.requestId),
    checkpoint: cnaiRouter.getCheckpoint(state, result.requestId)
  };
}

test('a genuinely completed+verified localCode request passes independent verification', async () => {
  const { snapshot, audit, checkpoint } = await runAndCollect({ requestType: 'x', platformHint: 'code' });
  const verdict = verifyRouterRecord(snapshot, audit, checkpoint);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
});

test('a BLOCKED request (no adapter) still passes verification (BLOCKED is honestly reported, not COMPLETED)', async () => {
  const { snapshot, audit, checkpoint } = await runAndCollect({ requestType: 'x', platformHint: 'm365' }, cnaiRouter.defaultAdapters());
  const verdict = verifyRouterRecord(snapshot, audit, checkpoint);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  assert.equal(snapshot.executionStatus, 'BLOCKED');
});

test('a PARTIAL (unverified success) request passes verification because it is not claiming COMPLETED', async () => {
  const adapters = cnaiRouter.defaultAdapters({ adapters: { sharepoint: async () => ({ success: true }) } });
  const { snapshot, audit, checkpoint } = await runAndCollect({ requestType: 'x', platformHint: 'sharepoint' }, adapters);
  const verdict = verifyRouterRecord(snapshot, audit, checkpoint);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  assert.equal(snapshot.executionStatus, 'PARTIAL');
});

test('CONFIRMED CATCH: a fabricated COMPLETED without VERIFIED is rejected by the independent verifier', () => {
  const fabricated = {
    requestId: 'r1', correlationId: 'c1', requestType: 't', riskLevel: 'LOW', costClass: 'FREE',
    selectedRoute: 'localCode', executionStatus: 'COMPLETED', verificationStatus: 'UNVERIFIED',
    checkpointId: 'r1#3', auditId: 'a1', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    errorCode: null, errorSummary: null
  };
  const audit = { auditId: 'a1', trail: [{ event: 'RECEIVED', detail: {}, timestamp: new Date().toISOString() }] };
  const checkpoint = { checkpointId: 'r1#3', history: [{ stage: 'RECEIVED', timestamp: new Date().toISOString() }] };
  const verdict = verifyRouterRecord(fabricated, audit, checkpoint);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.includes('unverified_result_marked_completed'));
});

test('CONFIRMED CATCH: a VERIFIED status without COMPLETED executionStatus is rejected', () => {
  const inconsistent = {
    requestId: 'r2', correlationId: 'c2', requestType: 't', riskLevel: 'LOW', costClass: 'FREE',
    selectedRoute: 'localCode', executionStatus: 'PARTIAL', verificationStatus: 'VERIFIED',
    checkpointId: 'r2#1', auditId: 'a2', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    errorCode: null, errorSummary: null
  };
  const audit = { auditId: 'a2', trail: [{ event: 'RECEIVED', detail: {}, timestamp: new Date().toISOString() }] };
  const checkpoint = { checkpointId: 'r2#1', history: [{ stage: 'RECEIVED', timestamp: new Date().toISOString() }] };
  const verdict = verifyRouterRecord(inconsistent, audit, checkpoint);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.includes('verified_without_completed_status'));
});

test('a terminal record missing checkpointId or an audit trail is rejected', () => {
  const noCheckpoint = {
    requestId: 'r3', correlationId: 'c3', requestType: 't', riskLevel: 'LOW', costClass: 'FREE',
    selectedRoute: 'localCode', executionStatus: 'COMPLETED', verificationStatus: 'VERIFIED',
    checkpointId: null, auditId: 'a3', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    errorCode: null, errorSummary: null
  };
  const verdict = verifyRouterRecord(noCheckpoint, { auditId: 'a3', trail: [{ event: 'RECEIVED' }] }, { checkpointId: null, history: [] });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.includes('terminal_without_checkpoint'));
  assert.ok(verdict.violations.includes('checkpoint_history_missing'));
});

test('rollback must disclose its state_only scope in the audit trail to pass', async () => {
  const state = cnaiRouter.createRouterState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'code' });
  cnaiRouter.rollbackRequest(state, result.requestId, 'manual');
  const snapshot = cnaiRouter.getStatus(state, result.requestId);
  const audit = cnaiRouter.getAuditTrail(state, result.requestId);
  const checkpoint = cnaiRouter.getCheckpoint(state, result.requestId);
  const verdict = verifyRouterRecord(snapshot, audit, checkpoint);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
});

test('a leaked secret anywhere in the exposed record fails the independent verifier', () => {
  const snapshot = {
    requestId: 'r4', correlationId: 'c4', requestType: 't', riskLevel: 'LOW', costClass: 'FREE',
    selectedRoute: 'localCode', executionStatus: 'FAILED', verificationStatus: 'FAILED',
    checkpointId: 'r4#1', auditId: 'a4', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    errorCode: 'ADAPTER_ERROR', errorSummary: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  };
  const audit = { auditId: 'a4', trail: [{ event: 'RECEIVED', detail: {}, timestamp: new Date().toISOString() }] };
  const checkpoint = { checkpointId: 'r4#1', history: [{ stage: 'RECEIVED', timestamp: new Date().toISOString() }] };
  const verdict = verifyRouterRecord(snapshot, audit, checkpoint);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.includes('secret_leak_detected'));
});

test('missing required fields are each reported', () => {
  const verdict = verifyRouterRecord({ requestId: 'r5' }, { auditId: 'a5', trail: [{ event: 'RECEIVED' }] }, { checkpointId: null, history: [{ stage: 'RECEIVED' }] });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.includes('missing_field:correlationId'));
  assert.ok(verdict.violations.includes('missing_field:riskLevel'));
});
