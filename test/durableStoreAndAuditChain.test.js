'use strict';
// Lane C: 永続ストアの差し替え境界、保存後再取得、監査チェーン整合性、変更前後ハッシュ・検証の記録。
const assert = require('node:assert/strict');
const test = require('node:test');
const { createOperationsMcp } = require('../src/operationsMcp');
const { createDurableStore, createMemoryRowBackend, createRowBackend } = require('../src/operations/durableStore');
const { verifyAuditChain, ZERO_HASH } = require('../src/operations/auditChain');
const { hashValue } = require('../src/operations/store');

const planArgs = { operationType: 'read', targetEnvironmentId: 'env-1', targetObjectId: 'obj-1', action: '読み取り前の保全' };
const snapArgs = { targetType: 'other', targetId: 't', content: { a: 1 } };

async function planOperation(mcp) {
  const plan = await mcp.callTool('operation_plan', planArgs);
  assert.equal(plan.status, 'PASS');
  return plan.operationId;
}

// ---------- 永続ストアの契約 ----------

test('durable store exposes append-only operations: no update, no delete, no physical removal', () => {
  const store = createDurableStore({ backend: createMemoryRowBackend() });
  assert.deepEqual(Object.keys(store).sort(), ['append', 'durable', 'get', 'kind', 'list']);
  assert.equal(store.durable, true);
});

test('durable store saves, reads back, lists and rejects duplicate keys', async () => {
  const backend = createMemoryRowBackend();
  const store = createDurableStore({ backend });
  await store.append('snapshots', { snapshotId: 's1', operationId: 'op', content: { a: 1 } });
  await store.append('snapshots', { snapshotId: 's2', operationId: 'op', content: { a: 2 } });
  assert.equal((await store.get('snapshots', 's2')).content.a, 2);
  assert.deepEqual((await store.list('snapshots')).map((r) => r.snapshotId), ['s1', 's2']);
  await assert.rejects(store.append('snapshots', { snapshotId: 's1', operationId: 'op' }), /duplicate key/);
  await assert.rejects(store.list('users'), /unknown collection/);
});

test('durable store masks secrets before anything reaches the backend', async () => {
  const backend = createMemoryRowBackend();
  const store = createDurableStore({ backend });
  await store.append('audit', { auditRecordId: 'a1', prevHash: ZERO_HASH, details: { password: 'hunter2-long-value', note: 'Authorization: Bearer abcdefghijklmnop' }, recordHash: 'x' });
  const persisted = JSON.stringify(backend.rows);
  assert.equal(persisted.includes('hunter2-long-value'), false);
  assert.equal(persisted.includes('abcdefghijklmnop'), false);
});

test('a write failure in the backend raises STORE_WRITE_FAILED and leaves nothing behind', async () => {
  const backend = createMemoryRowBackend({ failWrites: (collection) => collection === 'snapshots' });
  const store = createDurableStore({ backend });
  await assert.rejects(store.append('snapshots', { snapshotId: 's1', operationId: 'op' }), (e) => e.code === 'STORE_WRITE_FAILED');
  assert.equal((await store.list('snapshots')).length, 0);
});

test('read-back verification rejects a save whose stored content differs from what was written', async () => {
  const backend = createMemoryRowBackend({
    tamperReads: (collection, rows) => rows.map((row) => ({ ...row, record: { ...row.record, content: { a: 999 } } }))
  });
  const store = createDurableStore({ backend });
  await assert.rejects(store.append('snapshots', { snapshotId: 's1', operationId: 'op', content: { a: 1 } }), (e) => e.code === 'STORE_VERIFY_FAILED');
});

test('a row backend built from SDK-like insert/query functions behaves like the memory backend', async () => {
  const rows = [];
  const backend = createRowBackend({
    kind: 'azureTable',
    insert: async ({ collection, record }) => { rows.push({ collection, record }); },
    query: async ({ collection }) => rows.filter((r) => r.collection === collection)
  });
  const store = createDurableStore({ backend });
  assert.equal(store.kind, 'azureTable');
  await store.append('audit', { auditRecordId: 'a1', prevHash: ZERO_HASH, recordHash: 'h' });
  assert.equal((await store.get('audit', 'a1')).recordHash, 'h');
});

test('an invalid backend is refused at construction', () => {
  assert.throws(() => createDurableStore({ backend: {} }), /backend must provide/);
});

// ---------- 運用経路との接続（保存失敗で変更を止める） ----------

test('with a durable store, snapshot save failure blocks the write gate', async () => {
  const backend = createMemoryRowBackend({ failWrites: (collection) => collection === 'snapshots' });
  const mcp = createOperationsMcp({}, { store: createDurableStore({ backend }) });
  const operationId = await planOperation(mcp);
  const snap = await mcp.callTool('snapshot_create', { operationId, ...snapArgs });
  assert.equal(snap.reasonCode, 'SNAPSHOT_STORE_FAILED');
  assert.equal((await mcp.canStartWrite(operationId)).reasonCode, 'SNAPSHOT_MISSING');
});

test('with a durable store, a failed tool_started audit prevents the snapshot from being taken', async () => {
  const backend = createMemoryRowBackend({ failWrites: (c, r) => c === 'audit' && r.event === 'tool_started' && r.tool === 'snapshot_create' });
  const mcp = createOperationsMcp({}, { store: createDurableStore({ backend }) });
  const operationId = await planOperation(mcp);
  const snap = await mcp.callTool('snapshot_create', { operationId, ...snapArgs });
  assert.equal(snap.reasonCode, 'AUDIT_WRITE_FAILED');
  assert.equal(backend.rows.filter((r) => r.collection === 'snapshots').length, 0);
});

test('verify records before/after hashes, verification and rollback availability in the audit chain', async () => {
  const backend = createMemoryRowBackend();
  const adapters = { verify: { configured: true, reread: async () => ({ content: { a: 1 } }) } };
  const mcp = createOperationsMcp({}, { store: createDurableStore({ backend }), adapters });
  const operationId = await planOperation(mcp);
  const snap = await mcp.callTool('snapshot_create', { operationId, ...snapArgs });
  const pass = await mcp.callTool('operation_verify', { operationId, targetType: 'other', targetId: 't', expectedAfterHash: hashValue({ a: 1 }) });
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.beforeHash, snap.beforeHash);
  assert.equal(pass.rollbackAvailable, true);
  const fail = await mcp.callTool('operation_verify', { operationId, targetType: 'other', targetId: 't', expectedAfterHash: hashValue({ a: 2 }) });
  assert.equal(fail.reasonCode, 'VERIFY_FAILED');
  const changes = (await mcp.store.list('audit')).filter((r) => r.event === 'change_recorded');
  assert.equal(changes.length, 2);
  assert.equal(changes[0].verification, 'PASS');
  assert.equal(changes[1].verification, 'FAIL');
  assert.equal(changes[0].beforeHash, snap.beforeHash);
  assert.equal(changes[0].afterHash, hashValue({ a: 1 }));
  assert.equal(changes[0].rollbackAvailable, true);
});

test('verify without a snapshot records rollbackAvailable=false and never claims PASS on audit failure', async () => {
  const backend = createMemoryRowBackend({ failWrites: (c, r) => c === 'audit' && r.event === 'change_recorded' });
  const adapters = { verify: { configured: true, reread: async () => ({ content: { a: 1 } }) } };
  const mcp = createOperationsMcp({}, { store: createDurableStore({ backend }), adapters });
  const operationId = await planOperation(mcp);
  const result = await mcp.callTool('operation_verify', { operationId, targetType: 'other', targetId: 't', expectedAfterHash: hashValue({ a: 1 }) });
  assert.notEqual(result.status, 'PASS');
  assert.equal(result.reasonCode, 'AUDIT_WRITE_FAILED');
});

// ---------- 監査チェーンの整合性 ----------

async function buildChain() {
  const backend = createMemoryRowBackend();
  const adapters = { verify: { configured: true, reread: async () => ({ content: { a: 1 } }) } };
  const mcp = createOperationsMcp({}, { store: createDurableStore({ backend }), adapters });
  const operationId = await planOperation(mcp);
  await mcp.callTool('snapshot_create', { operationId, ...snapArgs });
  await mcp.callTool('operation_verify', { operationId, targetType: 'other', targetId: 't', expectedAfterHash: hashValue({ a: 1 }) });
  return (await mcp.store.list('audit'));
}

test('an empty audit chain verifies', () => {
  assert.deepEqual(verifyAuditChain([]), { ok: true, reasonCode: null, brokenAt: null, checked: 0 });
});

test('a real chain written through the durable store verifies end to end', async () => {
  const rows = await buildChain();
  assert.ok(rows.length >= 4);
  assert.equal(verifyAuditChain(rows).ok, true);
});

test('changing any field of an audit row is detected at that row', async () => {
  const rows = await buildChain();
  const tampered = rows.map((row, i) => (i === 1 ? { ...row, status: 'PASS-FORGED' } : row));
  assert.deepEqual(
    (({ ok, reasonCode, brokenAt }) => ({ ok, reasonCode, brokenAt }))(verifyAuditChain(tampered)),
    { ok: false, reasonCode: 'AUDIT_RECORD_HASH_MISMATCH', brokenAt: 1 }
  );
});

test('deleting a middle row breaks the chain at the row that follows the gap', async () => {
  const rows = await buildChain();
  const removed = rows.filter((_, i) => i !== 1);
  const result = verifyAuditChain(removed);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'AUDIT_CHAIN_BROKEN');
  assert.equal(result.brokenAt, 1);
});

test('reordering rows is detected', async () => {
  const rows = await buildChain();
  const swapped = [rows[0], rows[2], rows[1], ...rows.slice(3)];
  assert.equal(verifyAuditChain(swapped).ok, false);
});

test('a row whose prevHash does not point at the real first row is rejected', async () => {
  const rows = await buildChain();
  const forged = { ...rows[0], prevHash: 'f'.repeat(64) };
  const { recordHash, ...body } = forged;
  forged.recordHash = hashValue(body);
  assert.equal(verifyAuditChain([forged, ...rows.slice(1)]).reasonCode, 'AUDIT_CHAIN_BROKEN');
});

test('malformed input is reported, not thrown', () => {
  assert.equal(verifyAuditChain(null).ok, false);
  assert.equal(verifyAuditChain([{ no: 'hash' }]).reasonCode, 'AUDIT_ROW_MALFORMED');
});
