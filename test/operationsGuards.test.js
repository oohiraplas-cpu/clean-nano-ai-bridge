'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createOperationsMcp } = require('../src/operationsMcp');
const { createMemoryStore, hashValue } = require('../src/operations/store');
const { maskDeep, MASK } = require('../src/secretMasking');

const planArgs = { operationType: 'read', targetEnvironmentId: 'env-1', targetObjectId: 'obj-1', action: '読み取り前の保全' };

// 指定した条件の追記だけ失敗させるストア。
function failingStore(failWhen) {
  const base = createMemoryStore();
  return {
    kind: 'test',
    append(collection, record) {
      if (failWhen(collection, record, base.list(collection).length)) throw new Error('storage unavailable');
      return base.append(collection, record);
    },
    get: (collection, key) => base.get(collection, key),
    list: (collection) => base.list(collection)
  };
}

async function planOperation(mcp, overrides = {}) {
  const plan = await mcp.callTool('operation_plan', { ...planArgs, ...overrides });
  assert.equal(plan.status, 'PASS');
  return plan.operationId;
}

// ---------- Snapshot ----------

test('snapshot_create stores the masked content and records a hash that matches it', async () => {
  const mcp = createOperationsMcp({});
  const operationId = await planOperation(mcp);
  const content = { name: '社員A', apiKey: 'sk-live-abcdef123456', note: 'ok' };
  const snap = await mcp.callTool('snapshot_create', { operationId, targetType: 'sharepoint_list', targetId: 'list-1', content });
  assert.equal(snap.status, 'PASS');
  assert.equal(snap.snapshotStored, true);
  assert.equal(JSON.stringify(snap).includes('sk-live-abcdef123456'), false);

  const stored = mcp.store.get('snapshots', snap.snapshotId);
  assert.equal(stored.content.apiKey, MASK);
  assert.equal(stored.beforeHash, hashValue(maskDeep(content)));
  assert.equal(hashValue(stored.content), stored.beforeHash);
});

test('snapshot_create dry-run computes the hash without storing anything', async () => {
  const mcp = createOperationsMcp({});
  const operationId = await planOperation(mcp);
  const payload = await mcp.callTool('snapshot_create', { operationId, targetType: 'other', targetId: 't', content: { a: 1 }, dryRun: true });
  assert.equal(payload.status, 'PASS');
  assert.equal(payload.snapshotStored, false);
  assert.equal(mcp.store.list('snapshots').length, 0);
});

test('snapshot_create requires a registered, non-cancelled operation', async () => {
  const mcp = createOperationsMcp({});
  const missing = await mcp.callTool('snapshot_create', { operationId: 'nope', targetType: 'other', targetId: 't', content: {} });
  assert.equal(missing.reasonCode, 'TARGET_NOT_FOUND');
  const operationId = await planOperation(mcp);
  await mcp.callTool('operation_cancel', { operationId });
  const cancelled = await mcp.callTool('snapshot_create', { operationId, targetType: 'other', targetId: 't', content: {} });
  assert.equal(cancelled.reasonCode, 'INVALID_STATE');
});

test('when the snapshot store fails, snapshot_create reports failure and writes are not allowed to start', async () => {
  const store = failingStore((collection) => collection === 'snapshots');
  const mcp = createOperationsMcp({}, { store });
  const operationId = await planOperation(mcp);
  const snap = await mcp.callTool('snapshot_create', { operationId, targetType: 'other', targetId: 't', content: { a: 1 } });
  assert.equal(snap.status, 'FAIL');
  assert.equal(snap.reasonCode, 'SNAPSHOT_STORE_FAILED');
  assert.equal(snap.executed, false);
  const gate = mcp.canStartWrite(operationId);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reasonCode, 'SNAPSHOT_MISSING');
});

test('when the audit store fails before snapshot_create starts, nothing is snapshotted', async () => {
  const store = failingStore((collection, record) => collection === 'audit' && record.event === 'tool_started' && record.tool === 'snapshot_create');
  const mcp = createOperationsMcp({}, { store });
  const operationId = await planOperation(mcp);
  const snap = await mcp.callTool('snapshot_create', { operationId, targetType: 'other', targetId: 't', content: { a: 1 } });
  assert.equal(snap.reasonCode, 'AUDIT_WRITE_FAILED');
  assert.equal(store.list('snapshots').length, 0);
  assert.equal(mcp.canStartWrite(operationId).allowed, false);
});

test('when the completion audit fails after a snapshot is stored, the write gate still refuses', async () => {
  const store = failingStore((collection, record) => collection === 'audit' && record.event === 'tool_completed' && record.tool === 'snapshot_create');
  const mcp = createOperationsMcp({}, { store });
  const operationId = await planOperation(mcp);
  const snap = await mcp.callTool('snapshot_create', { operationId, targetType: 'other', targetId: 't', content: { a: 1 } });
  assert.equal(snap.status, 'FAIL');
  assert.equal(snap.reasonCode, 'AUDIT_WRITE_FAILED');
  assert.equal(store.list('snapshots').length, 1);
  assert.equal(mcp.canStartWrite(operationId).reasonCode, 'AUDIT_MISSING');
});

test('a completed snapshot with its audit trail allows the write gate', async () => {
  const mcp = createOperationsMcp({});
  const operationId = await planOperation(mcp);
  const snap = await mcp.callTool('snapshot_create', { operationId, targetType: 'other', targetId: 't', content: { a: 1 } });
  const gate = mcp.canStartWrite(operationId);
  assert.equal(gate.allowed, true);
  assert.equal(gate.snapshotId, snap.snapshotId);
  assert.equal(gate.beforeHash, snap.beforeHash);
});

test('the write gate refuses when a stored snapshot has been tampered with', async () => {
  const base = createMemoryStore();
  const tamper = (c, rows) => (c === 'snapshots' ? rows.map((row) => ({ ...row, content: { a: 999 } })) : rows);
  const store = {
    append: (c, r) => base.append(c, r),
    list: (c) => tamper(c, base.list(c)),
    get: (c, k) => {
      const row = base.get(c, k);
      return row && c === 'snapshots' ? { ...row, content: { a: 999 } } : row;
    }
  };
  const mcp = createOperationsMcp({}, { store });
  const operationId = await planOperation(mcp);
  await mcp.callTool('snapshot_create', { operationId, targetType: 'other', targetId: 't', content: { a: 1 } });
  assert.equal(mcp.canStartWrite(operationId).reasonCode, 'SNAPSHOT_INTEGRITY_FAILED');
});

// ---------- Audit ----------

test('audit rows form a hash chain and link each call by correlationId', async () => {
  const mcp = createOperationsMcp({});
  const plan = await mcp.callTool('operation_plan', { ...planArgs, correlationId: 'corr-chain-0001' });
  const rows = mcp.store.list('audit');
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].prevHash, '0'.repeat(64));
  for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i].prevHash, rows[i - 1].recordHash);
  for (const row of rows) {
    const { recordHash, ...body } = row;
    assert.equal(hashValue(body), recordHash);
  }
  assert.ok(rows.every((row) => row.correlationId === 'corr-chain-0001'));
  assert.equal(plan.correlationId, 'corr-chain-0001');
});

test('audit_write records the event with secrets masked', async () => {
  const mcp = createOperationsMcp({});
  const payload = await mcp.callTool('audit_write', { event: 'manual_check', status: 'PASS', details: { token: 'tok-abcdef-123456' } });
  assert.equal(payload.status, 'PASS');
  const row = mcp.store.list('audit').find((r) => r.auditRecordId === payload.auditRecordId);
  assert.equal(row.details.token, MASK);
  assert.equal(JSON.stringify(payload).includes('tok-abcdef-123456'), false);
});

test('a read that must be audited does not run when the audit cannot be stored', async () => {
  let called = false;
  const store = failingStore((collection, record) => collection === 'audit' && record.event === 'tool_started');
  const adapters = { permission: { configured: true, check: async () => { called = true; return { granted: [] }; } } };
  const mcp = createOperationsMcp({}, { store, adapters });
  const payload = await mcp.callTool('permission_check', { scope: 'sharepoint', requiredPermissions: ['Sites.Selected'] });
  assert.equal(payload.reasonCode, 'AUDIT_WRITE_FAILED');
  assert.equal(called, false);
});

test('audit_write reports failure when the store cannot persist', async () => {
  const store = failingStore((collection) => collection === 'audit');
  const payload = await createOperationsMcp({}, { store }).callTool('audit_write', { event: 'manual_check', status: 'PASS' });
  assert.equal(payload.reasonCode, 'AUDIT_WRITE_FAILED');
});

// ---------- permission / license / connection ----------

test('permission_check passes when every required permission is granted', async () => {
  const adapters = { permission: { configured: true, check: async () => ({ granted: ['Sites.Selected', 'x'] }) } };
  const payload = await createOperationsMcp({}, { adapters }).callTool('permission_check', { scope: 'sharepoint', requiredPermissions: ['Sites.Selected'] });
  assert.equal(payload.status, 'PASS');
});

test('permission_check fails and lists the missing permissions', async () => {
  const adapters = { permission: { configured: true, check: async () => ({ granted: [] }) } };
  const payload = await createOperationsMcp({}, { adapters }).callTool('permission_check', { scope: 'entra', requiredPermissions: ['User.Read'] });
  assert.equal(payload.status, 'FAIL');
  assert.equal(payload.reasonCode, 'PERMISSION_MISSING');
  assert.deepEqual(payload.missingPermissions, ['User.Read']);
});

test('permission_check is BLOCKED while its adapter is not configured', async () => {
  const payload = await createOperationsMcp({}).callTool('permission_check', { scope: 'azure', requiredPermissions: ['Reader'] });
  assert.equal(payload.status, 'BLOCKED');
  assert.equal(payload.reasonCode, 'ADAPTER_NOT_CONFIGURED');
  assert.equal(payload.executed, false);
});

test('license_check refuses premium plans and unlicensed subjects', async () => {
  const premium = { configured: true, check: async () => ({ licensed: true, premium: true }) };
  const none = { configured: true, check: async () => ({ licensed: false, premium: false }) };
  const ok = { configured: true, check: async () => ({ licensed: true, premium: false }) };
  const args = { licenseType: 'power_apps' };
  assert.equal((await createOperationsMcp({}, { adapters: { license: premium } }).callTool('license_check', args)).reasonCode, 'PREMIUM_REQUIRED');
  assert.equal((await createOperationsMcp({}, { adapters: { license: none } }).callTool('license_check', args)).reasonCode, 'LICENSE_REQUIRED');
  assert.equal((await createOperationsMcp({}, { adapters: { license: ok } }).callTool('license_check', args)).status, 'PASS');
});

test('connection_test reports reachability and latency, and is BLOCKED when unconfigured', async () => {
  const adapters = { connection: { configured: true, test: async () => ({ reachable: true, latencyMs: 42 }) } };
  const pass = await createOperationsMcp({}, { adapters }).callTool('connection_test', { target: 'graph' });
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.latencyMs, 42);
  const down = { configured: true, test: async () => ({ reachable: false }) };
  const fail = await createOperationsMcp({}, { adapters: { connection: down } }).callTool('connection_test', { target: 'github' });
  assert.equal(fail.reasonCode, 'CONNECTION_FAILED');
  assert.equal((await createOperationsMcp({}).callTool('connection_test', { target: 'github' })).status, 'BLOCKED');
});

// ---------- VERIFY ----------

test('operation_verify passes when the re-read hash matches the expected hash', async () => {
  const observed = { name: '確定値', password: 'pw-abcdef-1234' };
  const expected = hashValue(maskDeep(observed));
  const adapters = { verify: { configured: true, reread: async () => ({ content: observed }) } };
  const payload = await createOperationsMcp({}, { adapters }).callTool('operation_verify', {
    operationId: 'op-1', targetType: 'sharepoint_list', targetId: 'l', expectedAfterHash: expected
  });
  assert.equal(payload.status, 'PASS');
  assert.equal(payload.verified, true);
});

test('operation_verify fails when the observed state differs from the expected hash', async () => {
  const adapters = { verify: { configured: true, reread: async () => ({ content: { name: 'changed' } }) } };
  const payload = await createOperationsMcp({}, { adapters }).callTool('operation_verify', {
    operationId: 'op-1', targetType: 'other', targetId: 't', expectedAfterHash: 'a'.repeat(64)
  });
  assert.equal(payload.status, 'FAIL');
  assert.equal(payload.reasonCode, 'VERIFY_FAILED');
  assert.equal(payload.verified, false);
});

test('operation_verify is BLOCKED while the re-read adapter is not configured', async () => {
  const payload = await createOperationsMcp({}).callTool('operation_verify', {
    operationId: 'op-1', targetType: 'other', targetId: 't', expectedAfterHash: 'b'.repeat(64)
  });
  assert.equal(payload.status, 'BLOCKED');
});

// ---------- Rollback ----------

async function snapshotFor(mcp, content = { value: 'before' }) {
  const operationId = await planOperation(mcp);
  const snap = await mcp.callTool('snapshot_create', { operationId, targetType: 'sharepoint_list', targetId: 'list-9', content });
  return { operationId, snapshotId: snap.snapshotId };
}

test('rollback is reported as available when the snapshot matches its operation and hash', async () => {
  const mcp = createOperationsMcp({});
  const { operationId, snapshotId } = await snapshotFor(mcp);
  const payload = await mcp.callTool('rollback_execute', { operationId, snapshotId, dryRun: true });
  assert.equal(payload.status, 'PASS');
  assert.equal(payload.rollbackAvailable, true);
  assert.equal(payload.executed, false);
});

test('rollback is reported as not available for an unknown snapshot or a mismatched operation', async () => {
  const mcp = createOperationsMcp({});
  const { operationId, snapshotId } = await snapshotFor(mcp);
  const unknown = await mcp.callTool('rollback_execute', { operationId, snapshotId: 'missing' });
  assert.equal(unknown.reasonCode, 'ROLLBACK_NOT_AVAILABLE');
  assert.equal(unknown.rollbackAvailable, false);
  assert.equal(unknown.rollbackReason, 'SNAPSHOT_NOT_FOUND');
  const mismatch = await mcp.callTool('rollback_execute', { operationId: 'other-op', snapshotId });
  assert.equal(mismatch.rollbackReason, 'SNAPSHOT_OPERATION_MISMATCH');
});

test('rollback is reported as not available when the stored snapshot was altered', async () => {
  const base = createMemoryStore();
  const store = {
    append: (c, r) => base.append(c, r),
    list: (c) => base.list(c),
    get: (c, k) => {
      const row = base.get(c, k);
      if (c === 'snapshots' && row) row.content = { value: 'altered' };
      return row;
    }
  };
  const mcp = createOperationsMcp({}, { store });
  const { operationId, snapshotId } = await snapshotFor(mcp);
  const payload = await mcp.callTool('rollback_execute', { operationId, snapshotId });
  assert.equal(payload.rollbackReason, 'SNAPSHOT_INTEGRITY_FAILED');
  assert.equal(payload.rollbackAvailable, false);
});

test('rollback without an approval token is BLOCKED even when it is available', async () => {
  const mcp = createOperationsMcp({});
  const { operationId, snapshotId } = await snapshotFor(mcp);
  const payload = await mcp.callTool('rollback_execute', { operationId, snapshotId });
  assert.equal(payload.status, 'BLOCKED');
  assert.equal(payload.reasonCode, 'APPROVAL_REQUIRED');
  assert.equal(payload.rollbackAvailable, true);
  assert.equal(payload.executed, false);
});

test('rollback with an approval token but no restore adapter stays BLOCKED and does not execute', async () => {
  const adapters = { approval: { configured: true, verify: async () => ({ approved: true }) } };
  const mcp = createOperationsMcp({}, { adapters });
  const { operationId, snapshotId } = await snapshotFor(mcp);
  const payload = await mcp.callTool('rollback_execute', { operationId, snapshotId, approvalToken: 'approval-token-1' });
  assert.equal(payload.status, 'BLOCKED');
  assert.equal(payload.adapter, 'restore');
  assert.equal(payload.executed, false);
  assert.equal(JSON.stringify(payload).includes('approval-token-1'), false);
});

test('rollback with an invalid approval is refused', async () => {
  const adapters = { approval: { configured: true, verify: async () => ({ approved: false }) } };
  const mcp = createOperationsMcp({}, { adapters });
  const { operationId, snapshotId } = await snapshotFor(mcp);
  const payload = await mcp.callTool('rollback_execute', { operationId, snapshotId, approvalToken: 'bad-token-value' });
  assert.equal(payload.reasonCode, 'APPROVAL_INVALID');
  assert.equal(payload.executed, false);
});

test('rollback with a valid approval and restore adapter executes and reports completion', async () => {
  let restored = null;
  const adapters = {
    approval: { configured: true, verify: async () => ({ approved: true }) },
    restore: { configured: true, restore: async (input) => { restored = input; return { ok: true }; } }
  };
  const mcp = createOperationsMcp({}, { adapters });
  const { operationId, snapshotId } = await snapshotFor(mcp, { value: 'before' });
  const payload = await mcp.callTool('rollback_execute', { operationId, snapshotId, approvalToken: 'good-token-value' });
  assert.equal(payload.status, 'PASS');
  assert.equal(payload.executed, true);
  assert.deepEqual(restored.content, { value: 'before' });
  assert.equal(restored.targetId, 'list-9');
});

test('rollback reports ROLLBACK_FAILED when the restore adapter does not confirm success', async () => {
  const adapters = {
    approval: { configured: true, verify: async () => ({ approved: true }) },
    restore: { configured: true, restore: async () => ({ ok: false }) }
  };
  const mcp = createOperationsMcp({}, { adapters });
  const { operationId, snapshotId } = await snapshotFor(mcp);
  const payload = await mcp.callTool('rollback_execute', { operationId, snapshotId, approvalToken: 'good-token-value' });
  assert.equal(payload.reasonCode, 'ROLLBACK_FAILED');
  assert.equal(payload.executed, true);
});
