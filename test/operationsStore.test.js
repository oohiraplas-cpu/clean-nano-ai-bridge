'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMemoryStore, createFileStore, createOperationsStore, hashValue, canonicalJson } = require('../src/operations/store');
const { MASK } = require('../src/secretMasking');

const snapshot = (id, extra = {}) => ({ snapshotId: id, operationId: 'op-1', beforeHash: 'a'.repeat(64), content: { a: 1 }, ...extra });

test('memory store appends, reads and lists records in order', () => {
  const store = createMemoryStore();
  store.append('snapshots', snapshot('s1'));
  store.append('snapshots', snapshot('s2'));
  assert.equal(store.get('snapshots', 's2').snapshotId, 's2');
  assert.deepEqual(store.list('snapshots').map((row) => row.snapshotId), ['s1', 's2']);
  assert.equal(store.get('snapshots', 'missing'), null);
});

test('stores are append-only: duplicate keys are refused', () => {
  const store = createMemoryStore();
  store.append('snapshots', snapshot('s1'));
  assert.throws(() => store.append('snapshots', snapshot('s1')), /duplicate key/);
});

test('records are copied on the way in and out, so callers cannot mutate the store', () => {
  const store = createMemoryStore();
  const input = snapshot('s1');
  store.append('snapshots', input);
  input.content.a = 999;
  store.get('snapshots', 's1').content.a = 999;
  assert.equal(store.get('snapshots', 's1').content.a, 1);
});

test('secrets are masked before storage even if the caller forgot to mask them', () => {
  const store = createMemoryStore();
  store.append('snapshots', snapshot('s1', { content: { password: 'hunter2-long', note: 'Authorization: Bearer abcdefghijkl' } }));
  const stored = store.get('snapshots', 's1');
  assert.equal(stored.content.password, MASK);
  assert.equal(JSON.stringify(stored).includes('hunter2-long'), false);
  assert.equal(JSON.stringify(stored).includes('abcdefghijkl'), false);
});

test('unknown collections and records without the key are refused', () => {
  const store = createMemoryStore();
  assert.throws(() => store.append('users', { id: 'x' }), /unknown collection/);
  assert.throws(() => store.append('snapshots', { operationId: 'op' }), /missing key/);
  assert.throws(() => store.list('users'), /unknown collection/);
});

test('oversized records are refused', () => {
  const store = createMemoryStore();
  assert.throws(() => store.append('audit', { auditRecordId: 'a1', blob: 'x'.repeat(1024 * 1024 + 10) }), /too large/);
});

test('the store exposes no delete or update operation', () => {
  for (const store of [createMemoryStore(), createFileStore(path.join(os.tmpdir(), `ops-${process.pid}-probe.jsonl`))]) {
    const names = Object.keys(store);
    assert.deepEqual(names.filter((name) => /delete|remove|clear|purge|update|set/i.test(name)), []);
  }
});

test('file store persists across instances and keeps append-only semantics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-store-'));
  const file = path.join(dir, 'ops.jsonl');
  const first = createFileStore(file);
  first.append('snapshots', snapshot('s1'));
  const second = createFileStore(file);
  assert.equal(second.get('snapshots', 's1').snapshotId, 's1');
  assert.throws(() => second.append('snapshots', snapshot('s1')), /duplicate key/);
  assert.equal(second.list('snapshots').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file store refuses to write when its parent location is not a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-store-fail-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const store = createFileStore(path.join(blocker, 'ops.jsonl'));
  assert.throws(() => store.append('audit', { auditRecordId: 'a1' }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createOperationsStore chooses the file store only when a path is given', () => {
  assert.equal(createOperationsStore({}).kind, 'memory');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-store-kind-'));
  assert.equal(createOperationsStore({ filePath: path.join(dir, 'x.jsonl') }).kind, 'file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hashes are computed over canonical JSON, so key order does not change the hash', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(hashValue({ b: 1, a: 2 }), hashValue({ a: 2, b: 1 }));
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
});
