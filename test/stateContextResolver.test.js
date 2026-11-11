const test = require('node:test');
const assert = require('node:assert');
const StateContextResolver = require('../src/stateContextResolver');
const StateContextStore = require('../src/stateContextStore');

test('StateContextResolver: Resolve with explicit params', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  const resolver = new StateContextResolver({
    stateContextStore: store,
    config: {}
  });

  const params = {
    appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
    environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
    displayName: 'CN_AI依頼台帳',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'explicit-12345678-abcd'
  };

  const result = await resolver.resolve(params);

  assert.ok(result.complete);
  assert.equal(result.incomplete, false);
  assert.equal(result.stateContext.appId, params.appId);
  assert.equal(result.stateContext.branch, params.branch);
  assert.equal(result.stateContext.sha, params.sha);
  assert.equal(result.stateContext.state, params.state);
  assert.ok(result.stateContext.writable);

  store.shutdown();
});

test('StateContextResolver: Incomplete context without PowerAppsGitStore', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  const resolver = new StateContextResolver({
    stateContextStore: store,
    config: {}
  });

  const params = {
    appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
    environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
    displayName: 'CN_AI依頼台帳',
    correlationId: 'incomplete-12345678'
  };

  const result = await resolver.resolve(params);

  assert.equal(result.complete, false);
  assert.ok(result.incomplete);
  assert.ok(result.missing);
  assert.ok(result.missing.includes('branch'));
  assert.ok(result.missing.includes('sha'));
  assert.ok(result.missing.includes('state'));
  assert.ok(result.missing.includes('writable'));
  assert.ok(result.missing.includes('canonicalBranch'));

  store.shutdown();
});

test('StateContextResolver: Resolve from StateContextStore cache', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  const resolver = new StateContextResolver({
    stateContextStore: store,
    config: {}
  });

  const correlationId = 'cache-lookup-12345678';

  // Store context first
  const cachedContext = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'CN_AI依頼台帳',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'b'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId
  };

  store.set(cachedContext);

  // Resolve with partial params but matching correlationId
  const params = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'CN_AI依頼台帳'
  };

  const result = await resolver.resolve(params, correlationId);

  assert.equal(result.complete, true);
  assert.equal(result.stateContext.branch, 'main');
  assert.equal(result.stateContext.sha, 'b'.repeat(40));
  assert.ok(result.source.branch === 'stateContextStore');
  assert.ok(result.source.sha === 'stateContextStore');

  store.shutdown();
});

test('StateContextResolver: Generate correlationId if missing', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  const resolver = new StateContextResolver({
    stateContextStore: store,
    config: {}
  });

  const params = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'Test'
  };

  const result = await resolver.resolve(params);

  assert.ok(result.stateContext.correlationId);
  assert.ok(result.stateContext.correlationId.startsWith('aid-'));

  store.shutdown();
});

test('StateContextResolver: Prefer explicit params over cached', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  const resolver = new StateContextResolver({
    stateContextStore: store,
    config: {}
  });

  const correlationId = 'prefer-explicit-12345678';

  // Cache one version
  const cachedContext = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'CN_AI依頼台帳',
    branch: 'old-branch',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId
  };

  store.set(cachedContext);

  // Resolve with explicit branch (should override cache)
  const params = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'CN_AI依頼台帳',
    branch: 'new-branch',
    canonicalBranch: 'main',
    sha: 'b'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: false
  };

  const result = await resolver.resolve(params, correlationId);

  assert.equal(result.stateContext.branch, 'new-branch');
  assert.equal(result.stateContext.sha, 'b'.repeat(40));
  assert.equal(result.stateContext.writable, false);

  store.shutdown();
});

test('StateContextResolver: Store complete context', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  const resolver = new StateContextResolver({
    stateContextStore: store,
    config: {}
  });

  const correlationId = 'store-complete-12345678';

  const params = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'CN_AI依頼台帳',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'c'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId
  };

  const result = await resolver.resolve(params);

  assert.ok(result.complete);

  // Verify stored in cache
  const cached = store.get(correlationId);
  assert.ok(cached);
  assert.equal(cached.branch, 'main');
  assert.equal(cached.sha, 'c'.repeat(40));

  store.shutdown();
});

test('StateContextResolver: Get store stats', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  const resolver = new StateContextResolver({
    stateContextStore: store,
    config: {}
  });

  const ctx = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'Test',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'stats-12345678'
  };

  store.set(ctx);

  const stats = resolver.getStoreStats();
  assert.equal(stats.total, 1);
  assert.equal(stats.valid, 1);

  store.shutdown();
});

test('StateContextResolver: No store configured', async (t) => {
  const resolver = new StateContextResolver({
    stateContextStore: null,
    config: {}
  });

  const params = {
    appId: 'app-123',
    environmentId: 'env-456',
    displayName: 'Test',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'd'.repeat(40),
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'no-store-12345678'
  };

  const result = await resolver.resolve(params);

  assert.ok(result.complete);
  assert.equal(result.stateContext.correlationId, 'no-store-12345678');

  const stats = resolver.getStoreStats();
  assert.equal(stats.status, 'not_configured');
});
