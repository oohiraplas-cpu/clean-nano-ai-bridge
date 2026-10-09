const test = require('node:test');
const assert = require('node:assert');
const StateContextStore = require('../src/stateContextStore');
const StateContextResolver = require('../src/stateContextResolver');
const PowerAppsGitStore = require('../src/powerAppsGitStore');

/**
 * Integration test demonstrating stateContextComplete=true achievement
 * 
 * This test shows the full resolution pipeline:
 * 1. Explicit params (partial)
 * 2. StateContextStore (cached context lookup)
 * 3. PowerAppsGitStore (source file metadata)
 * 4. State derivation from sourceState
 * 5. Writable derivation from source
 * 
 * Result: complete=true with all 10 required fields resolved
 */

test('StateContextResolver: Integration - stateContextComplete=true with cached context', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  
  // Mock PowerAppsGitStore for this test
  const mockPowerAppsGitStore = {
    getSourceFile: async (relativePath) => {
      return {
        branch: 'main',
        canonicalBranch: 'main',
        sha: 'abcdef1234567890abcdef1234567890abcdef12',
        sourceState: 'github_canonical',
        writable: true,
        sourceControl: { bridgeMirrorState: 'active' }
      };
    }
  };

  const resolver = new StateContextResolver({
    stateContextStore: store,
    powerAppsGitStore: mockPowerAppsGitStore,
    config: {}
  });

  const correlationId = 'integration-test-12345678';

  // Step 1: Store a context with most fields (simulating previous call result)
  const cachedContext = {
    appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
    environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
    displayName: 'CN_AI依頼台帳',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'abcdef1234567890abcdef1234567890abcdef12',
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId
  };

  store.set(cachedContext);

  // Step 2: Resolve with partial params but same correlationId
  // This simulates a second request with minimal params but matching correlationId
  const params = {
    appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
    environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
    displayName: 'CN_AI依頼台帳'
    // branch, sha, state, writable NOT provided
  };

  const result = await resolver.resolve(params, correlationId);

  // Verify complete=true is achieved
  assert.equal(result.complete, true, 'stateContextComplete should be true');
  assert.equal(result.incomplete, false);
  assert.equal(result.missing, null, 'missing array should be null when complete');

  // Verify all 10 required fields are present
  assert.ok(result.stateContext.appId);
  assert.ok(result.stateContext.environmentId);
  assert.ok(result.stateContext.displayName);
  assert.ok(result.stateContext.branch);
  assert.ok(result.stateContext.canonicalBranch);
  assert.ok(result.stateContext.sha);
  assert.ok(result.stateContext.sourceOrigin);
  assert.ok(result.stateContext.state);
  assert.equal(result.stateContext.writable, true);
  assert.ok(result.stateContext.correlationId);

  // Verify sources show cache lookup worked
  assert.equal(result.source.branch, 'stateContextStore');
  assert.equal(result.source.sha, 'stateContextStore');
  assert.equal(result.source.state, 'stateContextStore');
  assert.equal(result.source.writable, 'stateContextStore');

  store.shutdown();
});

test('StateContextResolver: Integration - stateContextComplete=true with explicit params only', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  
  const resolver = new StateContextResolver({
    stateContextStore: store,
    powerAppsGitStore: null, // No git store needed
    config: {}
  });

  // All 10 required fields provided explicitly
  const params = {
    appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
    environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
    displayName: 'CN_AI依頼台帳',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'abcdef1234567890abcdef1234567890abcdef12',
    sourceOrigin: 'github:main',
    state: 'ready',
    writable: true,
    correlationId: 'explicit-test-12345678'
  };

  const result = await resolver.resolve(params);

  // Verify complete=true
  assert.equal(result.complete, true, 'stateContextComplete=true with all explicit params');
  assert.equal(result.missing, null);

  // Verify all fields are from explicit source
  assert.equal(result.source.appId, undefined); // Explicit fields not tracked in source
  assert.equal(result.stateContext.appId, params.appId);
  assert.equal(result.stateContext.branch, 'main');
  assert.equal(result.stateContext.writable, true);

  // Verify context is stored in cache
  const cached = store.get('explicit-test-12345678');
  assert.ok(cached, 'complete context should be stored in cache');
  assert.equal(cached.branch, 'main');

  store.shutdown();
});

test('StateContextResolver: Integration - stateContextComplete=false when missing required fields', async (t) => {
  const store = new StateContextStore({ ttlMs: 10000 });
  
  const resolver = new StateContextResolver({
    stateContextStore: store,
    powerAppsGitStore: null,
    config: {}
  });

  // Only 3 fields provided, missing: branch, canonicalBranch, sha, sourceOrigin, state, writable
  const params = {
    appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
    environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
    displayName: 'CN_AI依頼台帳'
  };

  const result = await resolver.resolve(params);

  // Verify complete=false
  assert.equal(result.complete, false, 'stateContextComplete should be false');
  assert.equal(result.incomplete, true);
  assert.ok(Array.isArray(result.missing));
  assert.ok(result.missing.length > 0);

  // Verify missing fields are reported
  assert.ok(result.missing.includes('branch'), 'branch should be in missing');
  assert.ok(result.missing.includes('sha'), 'sha should be in missing');
  assert.ok(result.missing.includes('state'), 'state should be in missing');
  assert.ok(result.missing.includes('writable'), 'writable should be in missing');

  // Verify context is NOT stored in cache (because incomplete)
  const cached = store.get(result.stateContext.correlationId);
  assert.equal(cached, null, 'incomplete context should NOT be cached');

  store.shutdown();
});
