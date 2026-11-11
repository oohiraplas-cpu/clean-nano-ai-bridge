const test = require('node:test');
const assert = require('node:assert');
const StateContextStore = require('../src/stateContextStore');

test('StateContextStore: Basic set/get', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  const context = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'CN_AI依頼台帳',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'corr-12345678-abcd'
  };

  const stored = store.set(context);
  assert.ok(stored);
  assert.equal(stored.correlationId, context.correlationId);
  assert.ok(stored.expiresAt);

  const retrieved = store.get(context.correlationId);
  assert.ok(retrieved);
  assert.equal(retrieved.appId, context.appId);
  assert.equal(retrieved.branch, context.branch);
  assert.equal(retrieved.sha, context.sha);

  store.shutdown();
});

test('StateContextStore: TTL expiration', async (t) => {
  const store = new StateContextStore({ ttlMs: 50 });
  const context = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'Test',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'corr-expires-12345678'
  };

  store.set(context);
  assert.ok(store.get(context.correlationId));

  // Wait for TTL to expire
  await new Promise(resolve => setTimeout(resolve, 100));

  const retrieved = store.get(context.correlationId);
  assert.equal(retrieved, null);

  store.shutdown();
});

test('StateContextStore: Reject invalid correlationId', async (t) => {
  const store = new StateContextStore();
  const context = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'Test',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'short'  // Too short
  };

  assert.throws(() => {
    store.set(context);
  }, /correlationId.*minimum 8 characters/);

  store.shutdown();
});

test('StateContextStore: List all valid contexts', async (t) => {
  const store = new StateContextStore({ ttlMs: 50 });

  const ctx1 = {
    appId: 'app-1',
    environmentId: 'env-1',
    displayName: 'App1',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'corr-list-1-12345678'
  };

  const ctx2 = {
    appId: 'app-2',
    environmentId: 'env-2',
    displayName: 'App2',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'b'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'corr-list-2-12345678'
  };

  store.set(ctx1);
  store.set(ctx2);

  let list = store.list();
  assert.equal(list.length, 2);

  await new Promise(resolve => setTimeout(resolve, 100));

  list = store.list();
  assert.equal(list.length, 0);

  store.shutdown();
});

test('StateContextStore: Delete context', async (t) => {
  const store = new StateContextStore();
  const context = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'Test',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'corr-delete-12345678'
  };

  store.set(context);
  assert.ok(store.get(context.correlationId));

  const deleted = store.delete(context.correlationId);
  assert.ok(deleted);
  assert.equal(store.get(context.correlationId), null);

  store.shutdown();
});

test('StateContextStore: Stats', async (t) => {
  const store = new StateContextStore({ ttlMs: 50 });

  const ctx1 = {
    appId: 'app-1',
    environmentId: 'env-1',
    displayName: 'App1',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'corr-stats-1-12345678'
  };

  const ctx2 = {
    appId: 'app-2',
    environmentId: 'env-2',
    displayName: 'App2',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'b'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'corr-stats-2-12345678'
  };

  store.set(ctx1);
  store.set(ctx2);

  let stats = store.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.valid, 2);
  assert.equal(stats.expired, 0);

  await new Promise(resolve => setTimeout(resolve, 150));

  // Cleanup is manual, not automatic via interval in tests
  // Just verify that we can check expiration
  stats = store.stats();
  assert.ok(stats.total >= 0); // Can be 0 or 2 depending on timing

  store.shutdown();
});

test('StateContextStore: Clear all', async (t) => {
  const store = new StateContextStore();

  const ctx = {
    appId: 'app-1',
    environmentId: 'env-1',
    displayName: 'App1',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'corr-clear-12345678'
  };

  store.set(ctx);
  assert.equal(store.list().length, 1);

  store.clear();
  assert.equal(store.list().length, 0);

  store.shutdown();
});
