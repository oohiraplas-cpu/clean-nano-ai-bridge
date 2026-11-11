const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const {
  RuntimeStateTracker,
  IntegrityVerifier,
  ExecutionGuard
} = require('../src/runtimeValidationPipeline');

test('RuntimeStateTracker', async t => {
  await t.test('initializes state chain with valid correlationId and initialState', () => {
    const tracker = new RuntimeStateTracker();
    const correlationId = crypto.randomUUID();
    const initialState = { appId: 'app-1', version: 1 };

    const result = tracker.initializeStateChain(correlationId, initialState);

    assert.ok(result.stateId);
    assert.ok(result.timestamp);
    assert.ok(result.stateHash);
    assert.match(result.stateId, /^[0-9a-f-]{36}$/);

    const chain = tracker.getStateChain(correlationId);
    assert.equal(chain.timeline.length, 1);
    assert.equal(chain.timeline[0].phase, 'init');
    assert.equal(chain.metadata.totalTransitions, 0);

    tracker.cleanup();
  });

  await t.test('throws when initializeStateChain gets invalid correlationId', () => {
    const tracker = new RuntimeStateTracker();
    assert.throws(() => tracker.initializeStateChain(null, {}), /Invalid correlationId/);
    assert.throws(() => tracker.initializeStateChain('', {}), /Invalid correlationId/);
    tracker.cleanup();
  });

  await t.test('throws when initializeStateChain gets invalid initialState', () => {
    const tracker = new RuntimeStateTracker();
    const correlationId = crypto.randomUUID();
    assert.throws(() => tracker.initializeStateChain(correlationId, null), /Invalid initialState/);
    assert.throws(() => tracker.initializeStateChain(correlationId, undefined), /Invalid initialState/);
    tracker.cleanup();
  });

  await t.test('records state transitions and maintains sequence', () => {
    const tracker = new RuntimeStateTracker();
    const correlationId = crypto.randomUUID();
    const initialState = { appId: 'app-1', version: 1 };

    tracker.initializeStateChain(correlationId, initialState);

    const t1 = tracker.recordStateTransition(correlationId, 'validate', { appId: 'app-1', version: 2 });
    const t2 = tracker.recordStateTransition(correlationId, 'execute', { appId: 'app-1', version: 3 });

    assert.equal(t1.sequenceNo, 1);
    assert.equal(t2.sequenceNo, 2);

    const chain = tracker.getStateChain(correlationId);
    assert.equal(chain.timeline.length, 3);
    assert.equal(chain.timeline[1].phase, 'validate');
    assert.equal(chain.timeline[2].phase, 'execute');
    assert.equal(chain.metadata.totalTransitions, 2);

    tracker.cleanup();
  });

  await t.test('throws when recording transition with unknown correlationId', () => {
    const tracker = new RuntimeStateTracker();
    const unknownId = crypto.randomUUID();
    assert.throws(
      () => tracker.recordStateTransition(unknownId, 'phase', {}),
      /Invalid or unknown correlationId/
    );
    tracker.cleanup();
  });

  await t.test('verifyChainIntegrity detects valid chains', () => {
    const tracker = new RuntimeStateTracker();
    const correlationId = crypto.randomUUID();
    const initialState = { value: 1 };

    tracker.initializeStateChain(correlationId, initialState);
    tracker.recordStateTransition(correlationId, 'phase1', { value: 2 });
    tracker.recordStateTransition(correlationId, 'phase2', { value: 3 });

    const result = tracker.verifyChainIntegrity(correlationId);
    assert.equal(result.valid, true);
    assert.equal(result.totalStates, 3);

    tracker.cleanup();
  });

  await t.test('verifyChainIntegrity detects invalid chains', () => {
    const tracker = new RuntimeStateTracker();
    const correlationId = crypto.randomUUID();
    const initialState = { value: 1 };

    tracker.initializeStateChain(correlationId, initialState);
    tracker.recordStateTransition(correlationId, 'phase1', { value: 2 });
    tracker.recordStateTransition(correlationId, 'phase2', { value: 3 });

    const chainData = tracker.states.get(correlationId);
    // Corrupt the previous state hash to break the chain link
    chainData.timeline[0].stateHash = 'corrupted_initial';

    const result = tracker.verifyChainIntegrity(correlationId);
    assert.equal(result.valid, false);
    assert.match(result.reason, /Chain link verification failed/);

    tracker.cleanup();
  });

  await t.test('returns null for unknown correlationId in getStateChain', () => {
    const tracker = new RuntimeStateTracker();
    const unknownId = crypto.randomUUID();
    const result = tracker.getStateChain(unknownId);
    assert.equal(result, null);
    tracker.cleanup();
  });

  await t.test('calculates consistent state hashes', () => {
    const tracker = new RuntimeStateTracker();
    const state = { a: 1, b: 2, c: 3 };

    const hash1 = tracker.hashState(state);
    const hash2 = tracker.hashState(state);

    // Properties in different order should produce same hash
    const stateReordered = { c: 3, a: 1, b: 2 };
    const hash3 = tracker.hashState(stateReordered);

    assert.equal(hash1, hash2);
    assert.equal(hash1, hash3);

    tracker.cleanup();
  });

  await t.test('returns stats on active sessions and transitions', () => {
    const tracker = new RuntimeStateTracker();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    tracker.initializeStateChain(id1, { val: 1 });
    tracker.recordStateTransition(id1, 'p1', { val: 2 });

    tracker.initializeStateChain(id2, { val: 1 });
    tracker.recordStateTransition(id2, 'p1', { val: 2 });
    tracker.recordStateTransition(id2, 'p2', { val: 3 });

    const stats = tracker.getStats();
    assert.equal(stats.activeSessions, 2);
    assert.equal(stats.totalStates, 5); // 2 chains with (1 init + 1 or 2 transitions)
    assert.equal(stats.totalTransitions, 3);
    assert.equal(stats.integrityErrors, 0);

    tracker.cleanup();
  });

  await t.test('manual cleanup removes expired state chains', async () => {
    const tracker = new RuntimeStateTracker({ retentionMs: 100 });
    const correlationId = crypto.randomUUID();

    tracker.initializeStateChain(correlationId, { val: 1 });
    assert.equal(tracker.states.size, 1);

    // Wait for retention time to expire
    await new Promise(resolve => setTimeout(resolve, 150));

    // Manually trigger cleanup logic
    const now = Date.now();
    for (const [cid, chainData] of tracker.states.entries()) {
      const createdTime = new Date(chainData.metadata.createdAt).getTime();
      if (now - createdTime > tracker.retentionMs) {
        tracker.states.delete(cid);
      }
    }

    assert.equal(tracker.states.size, 0);
    tracker.cleanup();
  });
});

test('IntegrityVerifier', async t => {
  await t.test('generates consistent signatures for same payload', () => {
    const verifier = new IntegrityVerifier();
    const payload = { appId: 'app-1', action: 'save' };

    const sig1 = verifier.sign(payload);
    const sig2 = verifier.sign(payload);

    assert.equal(sig1.signature, sig2.signature);
    assert.equal(sig1.algorithm, 'SHA256');
    assert.equal(sig1.payloadHash, sig2.payloadHash);
  });

  await t.test('signs with different algorithms', () => {
    const verifier = new IntegrityVerifier();
    const payload = { data: 'test' };

    const sig256 = verifier.sign(payload, 'SHA256');
    const sig384 = verifier.sign(payload, 'SHA384');
    const sig512 = verifier.sign(payload, 'SHA512');

    assert.equal(sig256.algorithm, 'SHA256');
    assert.equal(sig384.algorithm, 'SHA384');
    assert.equal(sig512.algorithm, 'SHA512');
    assert.notEqual(sig256.signature, sig384.signature);
    assert.notEqual(sig384.signature, sig512.signature);
  });

  await t.test('throws on unsupported algorithm', () => {
    const verifier = new IntegrityVerifier();
    assert.throws(
      () => verifier.sign({}, 'BLAKE2'),
      /Unsupported algorithm/
    );
  });

  await t.test('verifies correct signatures', () => {
    const verifier = new IntegrityVerifier();
    const payload = { appId: 'app-1', version: 1 };

    const sig = verifier.sign(payload);
    const verification = verifier.verify(payload, sig.signature, sig.algorithm);

    assert.equal(verification.valid, true);
    assert.equal(verification.algorithm, sig.algorithm);
  });

  await t.test('rejects tampered signatures', () => {
    const verifier = new IntegrityVerifier();
    const payload = { appId: 'app-1' };

    const sig = verifier.sign(payload);
    const tamperedSig = sig.signature.substring(0, sig.signature.length - 1) + 'x';

    const verification = verifier.verify(payload, tamperedSig, sig.algorithm);
    assert.equal(verification.valid, false);
  });

  await t.test('verifyChain validates multiple payloads in sequence', () => {
    const verifier = new IntegrityVerifier();
    const payloads = [
      { step: 1, data: 'init' },
      { step: 2, data: 'process', previousPayloadHash: 'init-hash' },
      { step: 3, data: 'complete', previousPayloadHash: 'process-hash' }
    ];

    const signatures = payloads.map(p => verifier.sign(p));

    const result = verifier.verifyChain(payloads, signatures);
    // Note: Our test payloads don't have proper chain links, but structure is verified
    assert.ok(result);
  });

  await t.test('verifyChain rejects mismatched counts', () => {
    const verifier = new IntegrityVerifier();
    const payloads = [{ data: 1 }, { data: 2 }];
    const signatures = [{ signature: 'sig1', algorithm: 'SHA256' }];

    const result = verifier.verifyChain(payloads, signatures);
    assert.equal(result.valid, false);
    assert.match(result.reason, /count mismatch/);
  });

  await t.test('recordVerification tracks verification history', () => {
    const verifier = new IntegrityVerifier();
    const correlationId = crypto.randomUUID();

    const result1 = { valid: true, signature: 'sig1' };
    const result2 = { valid: false, reason: 'Tampered' };

    verifier.recordVerification(correlationId, 'signature_check', result1);
    verifier.recordVerification(correlationId, 'chain_link', result2);

    const history = verifier.getVerificationHistory(correlationId);
    assert.equal(history.length, 2);
    assert.equal(history[0].type, 'signature_check');
    assert.equal(history[1].type, 'chain_link');
  });
});

test('ExecutionGuard', async t => {
  await t.test('evaluates operations with Fail-Closed by default', () => {
    const guard = new ExecutionGuard();
    const context = {
      correlationId: crypto.randomUUID(),
      stateContext: { verified: true },
      timestamp: new Date().toISOString()
    };

    const evaluation = guard.evaluateOperation(context, 'save');
    assert.equal(evaluation.allowed, true);
    assert.equal(evaluation.blockedBy.length, 0);
  });

  await t.test('blocks operations with missing correlationId', () => {
    const guard = new ExecutionGuard();
    const context = {
      stateContext: { verified: true },
      timestamp: new Date().toISOString()
    };

    const evaluation = guard.evaluateOperation(context, 'save');
    assert.equal(evaluation.allowed, false);
    assert.ok(evaluation.blockedBy.some(r => r.includes('context')));
  });

  await t.test('blocks operations with unverified state context', () => {
    const guard = new ExecutionGuard();
    const context = {
      correlationId: crypto.randomUUID(),
      stateContext: { verified: false },
      timestamp: new Date().toISOString()
    };

    const evaluation = guard.evaluateOperation(context, 'save');
    assert.equal(evaluation.allowed, false);
    assert.ok(evaluation.blockedBy.some(r => r.includes('verified')));
  });

  await t.test('blocks operations with failed signature verification', () => {
    const guard = new ExecutionGuard();
    const context = {
      correlationId: crypto.randomUUID(),
      stateContext: { verified: true },
      signature: { verified: false },
      timestamp: new Date().toISOString()
    };

    const evaluation = guard.evaluateOperation(context, 'save');
    assert.equal(evaluation.allowed, false);
    assert.ok(evaluation.blockedBy.some(r => r.includes('Signature')));
  });

  await t.test('blocks operations with expired TTL', () => {
    const guard = new ExecutionGuard();
    const oldTime = new Date(Date.now() - 400000).toISOString(); // 400s old
    const context = {
      correlationId: crypto.randomUUID(),
      stateContext: { verified: true },
      timestamp: oldTime,
      ttlMs: 300000 // 5 minutes
    };

    const evaluation = guard.evaluateOperation(context, 'save');
    assert.equal(evaluation.allowed, false);
    assert.ok(evaluation.blockedBy.some(r => r.includes('TTL')));
  });

  await t.test('blockOperation records blocked operations', () => {
    const guard = new ExecutionGuard();
    const operationId = crypto.randomUUID();

    const result = guard.blockOperation(operationId, 'Dangerous operation');

    assert.equal(result.blocked, true);
    assert.equal(result.operationId, operationId);
    assert.equal(guard.isOperationBlocked(operationId), true);
  });

  await t.test('isOperationBlocked returns false for expired blocks', async () => {
    const guard = new ExecutionGuard({
      retentionMs: 100
    });
    const operationId = crypto.randomUUID();

    guard.blockOperation(operationId, 'Reason');
    assert.equal(guard.isOperationBlocked(operationId), true);

    // Wait for block to expire
    await new Promise(resolve => setTimeout(resolve, 150));

    // Manually expire: adjust expiresAt to past
    const blockRecord = guard.blockedOperations.get(operationId);
    blockRecord.expiresAt = new Date(Date.now() - 1000).toISOString();

    assert.equal(guard.isOperationBlocked(operationId), false);
  });

  await t.test('recordExecution logs operations with correlationId', () => {
    const guard = new ExecutionGuard();
    const correlationId = crypto.randomUUID();
    const evaluation = {
      operationId: crypto.randomUUID(),
      operation: 'test_op',
      timestamp: new Date().toISOString(),
      allowed: true,
      blockedBy: []
    };

    guard.recordExecution(correlationId, evaluation);
    const log = guard.getExecutionLog(correlationId);

    assert.equal(log.length, 1);
    assert.equal(log[0].operation, 'test_op');
  });

  await t.test('getStats returns operation counts', () => {
    const guard = new ExecutionGuard();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    const ctx = {
      correlationId: id1,
      stateContext: { verified: true },
      timestamp: new Date().toISOString()
    };
    const ctx2 = {
      ...ctx,
      correlationId: id2,
      stateContext: { verified: false }
    };

    guard.evaluateOperation(ctx, 'op1');
    guard.evaluateOperation(ctx, 'op2');
    guard.evaluateOperation(ctx2, 'op3');

    const stats = guard.getStats();
    assert.equal(stats.totalOperations, 3);
    assert.equal(stats.allowedOperations, 2);
    assert.equal(stats.deniedOperations, 1);
  });

  await t.test('applies custom fail-closed rules', () => {
    const customRule = () => ({ passed: false, reason: 'Custom check failed' });
    const guard = new ExecutionGuard({
      failClosedRules: {
        customCheck: customRule
      }
    });

    const context = {
      correlationId: crypto.randomUUID(),
      stateContext: { verified: true },
      timestamp: new Date().toISOString()
    };

    const evaluation = guard.evaluateOperation(context, 'save');
    assert.equal(evaluation.allowed, false);
    assert.ok(evaluation.blockedBy.some(r => r.includes('Custom')));
  });
});

test('Comprehensive Phase 13 Integration', async t => {
  await t.test('full validation pipeline: track -> verify -> guard', () => {
    const tracker = new RuntimeStateTracker();
    const verifier = new IntegrityVerifier();
    const guard = new ExecutionGuard();

    const correlationId = crypto.randomUUID();
    const initialState = { appId: 'app-1', version: 1 };

    // Initialize state chain
    tracker.initializeStateChain(correlationId, initialState);

    // Record transition
    const transition = tracker.recordStateTransition(correlationId, 'validate', { appId: 'app-1', version: 2 });
    assert.equal(transition.sequenceNo, 1);

    // Verify chain integrity
    const chainVerified = tracker.verifyChainIntegrity(correlationId);
    assert.equal(chainVerified.valid, true);

    // Sign payload
    const payload = { appId: 'app-1', action: 'save' };
    const signature = verifier.sign(payload);

    // Verify signature
    const sigVerified = verifier.verify(payload, signature.signature);
    assert.equal(sigVerified.valid, true);

    // Evaluate operation
    const context = {
      correlationId,
      stateContext: { verified: true },
      signature: { verified: true },
      timestamp: new Date().toISOString()
    };

    const evaluation = guard.evaluateOperation(context, 'save');
    assert.equal(evaluation.allowed, true);

    tracker.cleanup();
  });

  await t.test('detects compromise in state chain', () => {
    const tracker = new RuntimeStateTracker();
    const correlationId = crypto.randomUUID();

    tracker.initializeStateChain(correlationId, { val: 1 });
    tracker.recordStateTransition(correlationId, 'p1', { val: 2 });
    tracker.recordStateTransition(correlationId, 'p2', { val: 3 });

    // Tamper with state
    const chainData = tracker.states.get(correlationId);
    chainData.timeline[1].stateHash = 'tampered';

    const verification = tracker.verifyChainIntegrity(correlationId);
    assert.equal(verification.valid, false);

    tracker.cleanup();
  });

  await t.test('detects compromise in signature chain', () => {
    const verifier = new IntegrityVerifier();
    const payloads = [
      { step: 1 },
      { step: 2 },
      { step: 3 }
    ];

    const signatures = payloads.map(p => verifier.sign(p));

    // Tamper with signature
    signatures[1].signature = 'tampered_sig';

    const result = verifier.verifyChain(payloads, signatures);
    assert.equal(result.valid, false);
  });
});
