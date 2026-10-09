const test = require('node:test');
const assert = require('node:assert');
const {
  RECOVERY_ACTION,
  RECOVERY_STATE,
  SelfRecoveryService
} = require('../src/selfRecoveryService');

test('Self-Recovery Service', async (t) => {
  await t.test('creates service with default config', () => {
    const service = new SelfRecoveryService();

    assert.ok(service);
    assert.strictEqual(service.autoRecoveryEnabled, true);
    assert.strictEqual(service.recoveryLog.length, 0);
  });

  await t.test('executes auto-renewal for expired context', async () => {
    const mockStore = new Map();
    const contextId = 'ctx-123';
    mockStore.set(contextId, {
      contextId,
      correlationId: 'corr-456',
      ttl: 900000
    });

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    const result = await service.executeRecovery('EXPIRED_STATE_CONTEXT', {
      contextId,
      ttl: 900000
    });

    assert.strictEqual(result.action, RECOVERY_ACTION.AUTO_RENEW);
    assert.ok(result.result.success);
    assert.ok(result.result.newContextId);
  });

  await t.test('regenerates context when missing', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    const result = await service.executeRecovery('MISSING_STATE_CONTEXT', {
      target: { appId: 'app-1' },
      source: { branch: 'feature-x' }
    });

    assert.strictEqual(result.action, RECOVERY_ACTION.CONTEXT_REGENERATE);
    assert.ok(result.result.success);
    assert.ok(result.result.contextId);
  });

  await t.test('marks policy exception as needing approval', async () => {
    const service = new SelfRecoveryService({
      autoRecoveryEnabled: true,
      approvalRequired: new Set([RECOVERY_ACTION.POLICY_EXCEPTION])
    });

    const result = await service.executeRecovery('POLICY_DENIED', {
      policyCode: 'DELETION_PROHIBITED'
    });

    assert.strictEqual(result.state, RECOVERY_STATE.NEEDS_APPROVAL);
    assert.strictEqual(result.approvalRequired, true);
  });

  await t.test('returns pending recovery for approval-required action', async () => {
    const service = new SelfRecoveryService({
      autoRecoveryEnabled: true,
      approvalRequired: new Set([RECOVERY_ACTION.POLICY_EXCEPTION])
    });

    const result = await service.executeRecovery('POLICY_DENIED');

    assert.strictEqual(result.state, RECOVERY_STATE.NEEDS_APPROVAL);
    assert.ok(result.recoveryId);
  });

  await t.test('stores recovery action in log', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    await service.executeRecovery('MISSING_STATE_CONTEXT');

    assert.strictEqual(service.recoveryLog.length, 1);
    assert.ok(service.recoveryLog[0].timestamp);
    assert.strictEqual(service.recoveryLog[0].failureCode, 'MISSING_STATE_CONTEXT');
  });

  await t.test('disables auto-recovery when configured', async () => {
    const mockStore = new Map();
    mockStore.set('ctx-123', {
      contextId: 'ctx-123',
      ttl: 900000
    });

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: false
    });

    const result = await service.executeRecovery('EXPIRED_STATE_CONTEXT', {
      contextId: 'ctx-123'
    });

    assert.strictEqual(result.state, RECOVERY_STATE.PENDING);
    assert.strictEqual(result.result, null);
  });

  await t.test('handles missing context store gracefully', async () => {
    const service = new SelfRecoveryService({
      stateContextStore: null,
      autoRecoveryEnabled: true
    });

    const result = await service.executeRecovery('MISSING_STATE_CONTEXT');

    assert.strictEqual(result.state, RECOVERY_STATE.FAILED);
    assert.ok(result.result?.reason || result.result?.error || result.error);
  });

  await t.test('handles transaction rollback and retry', async () => {
    const mockTx = {
      isFailed: () => true,
      isInProgress: () => false
    };

    const mockTxManager = {
      getTransaction: () => mockTx
    };

    const service = new SelfRecoveryService({
      transactionManager: mockTxManager,
      autoRecoveryEnabled: true
    });

    const result = await service.executeRecovery('TRANSACTION_FAILED', {
      transactionId: 'tx-123'
    });

    assert.strictEqual(result.action, RECOVERY_ACTION.ROLLBACK_RETRY);
    assert.ok(result.result.success);
  });

  await t.test('aborts stuck transaction', async () => {
    const now = Date.now();
    const mockTx = {
      startedAt: new Date(now - 400000), // 400 seconds ago
      isFailed: () => false,
      isInProgress: () => true
    };

    const mockTxManager = {
      getTransaction: () => mockTx
    };

    const service = new SelfRecoveryService({
      transactionManager: mockTxManager,
      autoRecoveryEnabled: true
    });

    const result = await service.executeRecovery('TRANSACTION_STUCK', {
      transactionId: 'tx-123',
      timeout: 300000 // 5 minutes
    });

    assert.strictEqual(result.action, RECOVERY_ACTION.TRANSACTION_ABORT);
    assert.ok(result.result.success);
  });

  await t.test('approves pending recovery action', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: false,
      approvalRequired: new Set([RECOVERY_ACTION.POLICY_EXCEPTION])
    });

    const result1 = await service.executeRecovery('POLICY_DENIED');
    const recoveryId = result1.recoveryId;

    const result2 = await service.approveRecovery(recoveryId, 'admin@example.com');

    assert.strictEqual(result2.success, false);
    assert.ok(result2.state);
  });

  await t.test('denies pending recovery action', async () => {
    const service = new SelfRecoveryService({
      autoRecoveryEnabled: false,
      approvalRequired: new Set([RECOVERY_ACTION.POLICY_EXCEPTION])
    });

    const result1 = await service.executeRecovery('POLICY_DENIED');
    const recoveryId = result1.recoveryId;

    const result2 = await service.denyRecovery(recoveryId, 'reviewer@example.com', 'Too risky');

    assert.strictEqual(result2.success, true);
    assert.strictEqual(result2.state, RECOVERY_STATE.CANCELLED);

    const recovery = service.recoveryLog.find(r => r.recoveryId === recoveryId);
    assert.strictEqual(recovery.denier, 'reviewer@example.com');
    assert.strictEqual(recovery.denialReason, 'Too risky');
  });

  await t.test('cannot approve already-executed recovery', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    const result1 = await service.executeRecovery('MISSING_STATE_CONTEXT');
    const recoveryId = result1.recoveryId;

    const result2 = await service.approveRecovery(recoveryId, 'admin@example.com');

    assert.strictEqual(result2.success, false);
    assert.ok(result2.reason.includes('not pending approval'));
  });

  await t.test('returns unknown action for unrecognized failure code', async () => {
    const service = new SelfRecoveryService({
      autoRecoveryEnabled: true
    });

    const result = await service.executeRecovery('UNKNOWN_FAILURE', {});

    assert.strictEqual(result.action, RECOVERY_ACTION.MANUAL_REVIEW);
    assert.strictEqual(result.state, RECOVERY_STATE.FAILED);
  });

  await t.test('filters recovery history by state', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    await service.executeRecovery('MISSING_STATE_CONTEXT');
    await service.executeRecovery('MISSING_STATE_CONTEXT');

    const history = service.getRecoveryHistory({ state: RECOVERY_STATE.SUCCEEDED });

    assert.strictEqual(history.length, 2);
  });

  await t.test('filters recovery history by action', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    await service.executeRecovery('MISSING_STATE_CONTEXT');
    await service.executeRecovery('POLICY_DENIED');

    const history = service.getRecoveryHistory({ action: RECOVERY_ACTION.CONTEXT_REGENERATE });

    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].action, RECOVERY_ACTION.CONTEXT_REGENERATE);
  });

  await t.test('filters recovery history by failure code', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    await service.executeRecovery('MISSING_STATE_CONTEXT');
    await service.executeRecovery('MISSING_STATE_CONTEXT');
    await service.executeRecovery('POLICY_DENIED');

    const history = service.getRecoveryHistory({ failureCode: 'MISSING_STATE_CONTEXT' });

    assert.strictEqual(history.length, 2);
  });

  await t.test('limits recovery history results', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    for (let i = 0; i < 5; i++) {
      await service.executeRecovery('MISSING_STATE_CONTEXT');
    }

    const history = service.getRecoveryHistory({ limit: 2 });

    assert.strictEqual(history.length, 2);
  });

  await t.test('provides recovery statistics', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    await service.executeRecovery('MISSING_STATE_CONTEXT');
    await service.executeRecovery('MISSING_STATE_CONTEXT');

    const stats = service.getStatistics();

    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.succeeded, 2);
    assert.strictEqual(stats.failed, 0);
    assert.ok(stats.byAction[RECOVERY_ACTION.CONTEXT_REGENERATE]);
    assert.ok(stats.byFailureCode.MISSING_STATE_CONTEXT);
  });

  await t.test('counts failed recoveries in statistics', async () => {
    const service = new SelfRecoveryService({
      stateContextStore: null,
      autoRecoveryEnabled: true
    });

    await service.executeRecovery('MISSING_STATE_CONTEXT');

    const stats = service.getStatistics();

    assert.strictEqual(stats.total, 1);
    assert.strictEqual(stats.failed, 1);
  });

  await t.test('counts pending approvals in statistics', async () => {
    const service = new SelfRecoveryService({
      autoRecoveryEnabled: false,
      approvalRequired: new Set([RECOVERY_ACTION.POLICY_EXCEPTION])
    });

    await service.executeRecovery('POLICY_DENIED');

    const stats = service.getStatistics();

    assert.strictEqual(stats.total, 1);
    assert.strictEqual(stats.pending, 1);
  });

  await t.test('stores approver information when recovery approved', async () => {
    const mockStore = new Map();

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: false,
      approvalRequired: new Set([RECOVERY_ACTION.POLICY_EXCEPTION])
    });

    const result1 = await service.executeRecovery('POLICY_DENIED');
    const recoveryId = result1.recoveryId;

    await service.approveRecovery(recoveryId, 'alice@example.com');

    const recovery = service.recoveryLog.find(r => r.recoveryId === recoveryId);
    assert.strictEqual(recovery.approver, 'alice@example.com');
    assert.ok(recovery.approvedAt);
  });

  await t.test('handles context renewal with new ID', async () => {
    const mockStore = new Map();
    const originalContextId = 'ctx-original';
    mockStore.set(originalContextId, {
      contextId: originalContextId,
      correlationId: 'corr-123',
      ttl: 900000
    });

    const service = new SelfRecoveryService({
      stateContextStore: {
        get: (id) => mockStore.get(id),
        set: (id, ctx) => mockStore.set(id, ctx)
      },
      autoRecoveryEnabled: true
    });

    const result = await service.executeRecovery('EXPIRED_STATE_CONTEXT', {
      contextId: originalContextId
    });

    assert.ok(result.result.success);
    assert.notStrictEqual(result.result.newContextId, originalContextId);
    assert.ok(mockStore.has(result.result.newContextId));
  });

  await t.test('returns failure for non-existent recovery during approval', async () => {
    const service = new SelfRecoveryService();

    const result = await service.approveRecovery('nonexistent-id', 'admin@example.com');

    assert.strictEqual(result?.success, false);
    assert.ok(result?.reason);
  });

  await t.test('returns failure for non-existent recovery during denial', () => {
    const service = new SelfRecoveryService();

    const result = service.denyRecovery('nonexistent-id', 'admin@example.com', 'Denied');

    assert.strictEqual(result.success, false);
    assert.ok(result.reason);
  });

  await t.test('respects custom timeout in transaction abort detection', async () => {
    const now = Date.now();
    const mockTx = {
      startedAt: new Date(now - 100000), // 100 seconds ago
      isFailed: () => false,
      isInProgress: () => true
    };

    const mockTxManager = {
      getTransaction: () => mockTx
    };

    const service = new SelfRecoveryService({
      transactionManager: mockTxManager,
      autoRecoveryEnabled: true
    });

    const result = await service.executeRecovery('TRANSACTION_STUCK', {
      transactionId: 'tx-123',
      timeout: 50000 // 50 seconds - much shorter than actual stuck time
    });

    assert.ok(result.result.success);
    assert.ok(result.result.stuckDuration);
  });
});
