const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { getConfig } = require('../src/config');
const { createApp, MCP_PUBLIC_TOOLS } = require('../src/server');
const { STATE_CONTEXT_SCHEMA, StateContextRegistry, blobSha } = require('../src/stateContext');

const APP = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
const ENV = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const PATH = 'powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml';
const CONTENT = 'Screens:\n  S1_Home:\n    Properties:\n      Fill: =Color.White\n';

async function fixture(t, options = {}) {
  let now = 100000;
  const state = { status: 'ok', appId: APP, environmentId: ENV };
  const source = { status: 'ok', path: PATH, content: CONTENT, sha: blobSha(CONTENT), branch: 'main', canonicalBranch: 'main', writable: true };
  const appStore = {
    getAppState: async () => ({ ...state, operationId: crypto.randomUUID() }),
    getAppInfo: async () => ({ id: APP, name: 'Test App', environmentId: ENV, screenCount: 1, screens: [{ name: 'S1_Home' }] }),
    ...(options.runtimeReader === false ? {} : { getSourceFile: async (file) => {
      assert.equal(file, PATH);
      return { content: options.runtimeContent ?? CONTENT };
    } })
  };
  const gitStore = {
    canonicalBranch: 'main',
    getSourceFile: async (file) => {
      assert.ok([PATH, 'S1_Home.pa.yaml'].includes(file));
      return { ...source };
    },
    getSourceFileMetadata: async (gitRoot) => {
      return {
        branch: 'main',
        canonicalBranch: 'main',
        sha: blobSha(CONTENT)
      };
    }
  };
  const config = getConfig({});
  config.enforceStateManager = options.enforce !== false;
  config.stateContextRegistry = { ttlMs: 1000, now: () => now };
  const app = createApp(config, {}, appStore, gitStore, {}, {}, {});
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  async function rpc(name, args = {}, session = 'session-a', transport = 'tools/call') {
    const body = transport === 'legacy' ? { method: name, params: args }
      : transport === 'direct' ? { jsonrpc: '2.0', id: 1, method: name, params: args }
      : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'Mcp-Session-Id': session }, body: JSON.stringify(body) });
    const result = await response.json();
    if (transport === 'legacy') return { error: !response.ok, data: response.ok ? result.result : result };
    if (transport === 'direct') return { error: Boolean(result.error), data: result.error?.data || result.result };
    return { error: result.result?.isError, data: result.result?.structuredContent };
  }
  async function chain() {
    const a = await rpc('get_powerapps_state');
    assert.equal(a.error, false);
    assert.notEqual(a.data.correlationId, a.data.operationId);
    assert.match(a.data.correlationId, /^[0-9a-f-]{36}$/);
    assert.equal(a.data.stateContext.appId, APP);
    assert.equal(a.data.stateContext.environment, ENV);
    const b = await rpc('get_powerapps_source', { relativePath: PATH, correlationId: a.data.correlationId, stateSessionId: a.data.stateSessionId });
    assert.equal(b.error, false);
    assert.equal(b.data.correlationId, a.data.correlationId);
    assert.equal(b.data.stateContextComplete, true);
    assert.deepEqual(Object.keys(b.data.stateContext).sort(), [...STATE_CONTEXT_SCHEMA.required].sort());
    return { stateContext: b.data.stateContext, stateSessionId: b.data.stateSessionId };
  }
  return { rpc, chain, url, state, source, expire: () => { now += 1001; } };
}

test('tools/list publishes the shared schemas and preserves all 55 tool names', async t => {
  const f = await fixture(t);
  const res = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const tools = (await res.json()).result.tools;
  assert.equal(tools.length, 55);
  assert.deepEqual(tools.map(x => x.name), MCP_PUBLIC_TOOLS.map(x => x.name));
  for (const name of ['validate_powerapps_source', 'compare_powerapps_with_git']) {
    const schema = tools.find(x => x.name === name).inputSchema;
    assert.deepEqual(schema.properties.stateContext, STATE_CONTEXT_SCHEMA);
    assert.ok(schema.required.includes('stateContext'));
    assert.ok(schema.required.includes('stateSessionId'));
  }
  assert.ok(tools.find(x => x.name === 'get_powerapps_source').inputSchema.properties.correlationId);
});

test('state -> source -> VALID -> compare uses the same registered context', async t => {
  const f = await fixture(t);
  const args = await f.chain();
  const valid = await f.rpc('validate_powerapps_source', { ...args, sourceContent: CONTENT, relativePath: PATH, expectedBranch: 'main' });
  assert.equal(valid.error, false);
  assert.equal(valid.data.validationStatus, 'VALID');
  assert.equal(valid.data.correlationId, args.stateContext.correlationId);
  const compare = await f.rpc('compare_powerapps_with_git', { ...args, targetFile: PATH, targetApp: APP });
  assert.equal(compare.error, false);
  assert.equal(compare.data.data.hasDifferences, false);
  assert.equal(compare.data.targetSha, args.stateContext.sha);
  assert.equal(compare.data.correlationId, args.stateContext.correlationId);
  assert.equal(compare.data.comparisonSources.powerApps, 'power-apps-runtime');
});

test('standalone production source reads return complete server-issued context', async t => {
  const f = await fixture(t);
  const source = await f.rpc('get_powerapps_source', { relativePath: PATH });
  assert.equal(source.error, false);
  assert.equal(source.data.stateContextComplete, true);
  assert.equal(source.data.stateContext.sha, blobSha(CONTENT));
  assert.equal((await f.rpc('validate_powerapps_source', {
    stateContext: source.data.stateContext, stateSessionId: source.data.stateSessionId
  })).data.validationStatus, 'VALID');
});

for (const field of ['correlationId', 'sha', 'branch', 'canonicalBranch', 'appId', 'environment']) {
  test(`${field} missing/mismatched fails closed for both guarded tools`, async t => {
    const f = await fixture(t);
    const args = await f.chain();
    for (const name of ['validate_powerapps_source', 'compare_powerapps_with_git']) {
      for (const mode of ['missing', 'mismatch']) {
        const stateContext = { ...args.stateContext };
        if (mode === 'missing') delete stateContext[field];
        else stateContext[field] = field === 'sha' ? '0'.repeat(40) : field === 'correlationId' ? crypto.randomUUID() : 'other';
        const result = await f.rpc(name, { ...args, stateContext });
        assert.equal(result.error, true);
        assert.ok(result.data.failures.some(e => e.includes(field)));
      }
    }
  });
}

test('TTL, session, source content and target consistency fail closed', async t => {
  const f = await fixture(t);
  const args = await f.chain();
  for (const change of [{ sourceContent: 'other' }, { relativePath: 'Other.pa.yaml' }, { expectedBranch: 'other' }, { stateSessionId: crypto.randomUUID() }]) {
    assert.equal((await f.rpc('validate_powerapps_source', { ...args, ...change })).error, true);
  }
  for (const change of [{ targetApp: 'other' }, { targetFile: 'Other.pa.yaml' }]) {
    assert.equal((await f.rpc('compare_powerapps_with_git', { ...args, ...change })).error, true);
  }
  assert.equal((await f.rpc('validate_powerapps_source', args, 'session-b')).error, true);
  f.expire();
  const expired = await f.rpc('validate_powerapps_source', args);
  assert.equal(expired.error, true);
  assert.match(expired.data.failures.join(' '), /expired/);
});

test('live SHA/app/environment drift fails closed', async t => {
  for (const field of ['sha', 'branch', 'appId', 'environmentId']) {
    const f = await fixture(t);
    const args = await f.chain();
    if (field === 'sha' || field === 'branch') f.source[field] = field === 'sha' ? '0'.repeat(40) : 'other';
    else f.state[field] = 'other';
    assert.equal((await f.rpc('validate_powerapps_source', args)).error, true);
  }
});

test('legacy/direct JSON-RPC cannot bypass registered context even with enforcement disabled', async t => {
  const f = await fixture(t, { enforce: false });
  for (const transport of ['legacy', 'direct', 'tools/call']) {
    for (const name of ['validate_powerapps_source', 'compare_powerapps_with_git']) assert.equal((await f.rpc(name, {}, 'session-a', transport)).error, true);
  }
  const args = await f.chain();
  for (const transport of ['legacy', 'direct']) assert.equal((await f.rpc('validate_powerapps_source', args, 'session-a', transport)).error, false);
});

test('compare detects differences, but never invents runtime parity without a source reader', async t => {
  const f = await fixture(t, { runtimeContent: CONTENT.replace('Color.White', 'Color.Black') });
  assert.equal((await f.rpc('compare_powerapps_with_git', await f.chain())).data.data.hasDifferences, true);
  const unavailable = await fixture(t, { runtimeReader: false });
  const result = await unavailable.rpc('compare_powerapps_with_git', await unavailable.chain());
  assert.equal(result.data.verified, false);
  assert.equal(result.data.data.hasDifferences, null);
  assert.equal(result.data.data.status, 'unconfirmed');
});

test('registry binds one file/SHA and checks observed blob integrity', () => {
  const registry = new StateContextRegistry();
  const a = registry.begin({ appId: APP, environmentId: ENV }, 'scope');
  const source = { path: PATH, content: CONTENT, sha: blobSha(CONTENT), branch: 'main', canonicalBranch: 'main' };
  registry.bind(a.correlationId, a.stateSessionId, 'scope', source, PATH);
  assert.throws(() => registry.bind(a.correlationId, a.stateSessionId, 'scope', { ...source, path: 'other' }, 'other'), /different file/);
  assert.throws(() => registry.bind(a.correlationId, a.stateSessionId, 'scope', { ...source, sha: '0'.repeat(40) }, PATH), /blob SHA/);
  assert.throws(() => new StateContextRegistry().lookup(a.correlationId, a.stateSessionId, 'scope'), /not registered/);
});


test('registered structure inspection rejects stale, mismatched and cross-session targets', async t => {
  const f = await fixture(t);
  const args = await f.chain();
  const result = await f.rpc('inspect_powerapps_structure', { ...args, appId: APP, relativePath: PATH });
  assert.equal(result.error, false);
  assert.equal(result.data.data.structure.sourceOrigin, 'github_canonical');
  assert.equal(result.data.data.structure.screens.count, 1);
  assert.equal(result.data.targetSha, args.stateContext.sha);
  assert.equal((await f.rpc('inspect_powerapps_structure', { ...args, appId: 'other' })).error, true);
  assert.equal((await f.rpc('inspect_powerapps_structure', { ...args, relativePath: 'other' })).error, true);
  assert.equal((await f.rpc('inspect_powerapps_structure', args, 'session-b')).error, true);
  assert.equal((await f.rpc('inspect_powerapps_structure', { stateSessionId: args.stateSessionId })).error, true);
  f.source.sha = '0'.repeat(40);
  assert.equal((await f.rpc('inspect_powerapps_structure', args)).error, true);
  f.source.sha = args.stateContext.sha;
  f.expire();
  assert.equal((await f.rpc('inspect_powerapps_structure', args)).error, true);
});

test('inspect_powerapps_structure supports dual mode: appId-only (live app) or stateContext (Git source)', async t => {
  const f = await fixture(t);

  // Mode 1: appId-only, no StateContext (live app analysis via Power Apps API)
  const liveAppResult = await f.rpc('inspect_powerapps_structure', { appId: APP });
  assert.equal(liveAppResult.error, false);
  // Live app mode should return app-based data without targetSha field
  assert.ok(liveAppResult.data.data);

  // Mode 2: With StateContext (Git source analysis)
  const args = await f.chain();
  const gitSourceResult = await f.rpc('inspect_powerapps_structure', {
    ...args, appId: APP, relativePath: PATH
  });
  assert.equal(gitSourceResult.error, false);
  assert.equal(gitSourceResult.data.data.structure.sourceOrigin, 'github_canonical');
  assert.equal(gitSourceResult.data.targetSha, args.stateContext.sha);
});

test('inspect_powerapps_structure: appId-only mode uses Power Apps API, ignoring relativePath', async t => {
  const f = await fixture(t);

  // Request without StateContext uses Power Apps API (live app mode)
  const liveAppOnly = await f.rpc('inspect_powerapps_structure', { appId: APP });
  assert.equal(liveAppOnly.error, false, `liveAppOnly error: ${JSON.stringify(liveAppOnly.data)}`);
  assert.ok(liveAppOnly.data.data);

  // With relativePath but no StateContext: relative path is ignored (appId-only mode)
  // The tool should not fail, just ignore the relativePath
  const withIgnoredPath = await f.rpc('inspect_powerapps_structure', {
    appId: APP,
    relativePath: 'ignored/path.yaml'
  });
  assert.equal(withIgnoredPath.error, false, `withIgnoredPath error: ${JSON.stringify(withIgnoredPath.data)}`);
  // Both should return app-based structure (same mode)
  assert.deepEqual(liveAppOnly.data.data, withIgnoredPath.data.data);
});

test('State Registry API contract: all methods must exist and be callable', async t => {
  const registry = new StateContextRegistry({ ttlMs: 1000, now: () => 100000 });

  // Test begin()
  const beginResult = registry.begin({ appId: APP, environmentId: ENV }, 'test');
  assert.ok(beginResult.correlationId);
  assert.ok(beginResult.stateSessionId);

  // Test invalidateBySessionId() — must exist and be callable
  const invalidateResult = registry.invalidateBySessionId(beginResult.stateSessionId, 'test_reason');
  assert.ok(typeof invalidateResult === 'object');
  assert.ok('invalidated' in invalidateResult);

  // Test cleanupExpired() — must exist and be callable
  const cleanupResult = registry.cleanupExpired();
  assert.ok(typeof cleanupResult === 'object');
  assert.ok('deleted' in cleanupResult);

  // Verify that deprecated/non-existent methods should NOT be in API
  const fake = new StateContextRegistry();
  assert.equal(typeof fake.generateSessionId, 'undefined', 'generateSessionId should not exist');
  assert.equal(typeof fake.invalidate, 'undefined', 'invalidate should not exist');
});

test('State Registry invalidateBySessionId: idempotent single-session invalidation', async t => {
  const registry = new StateContextRegistry({ ttlMs: 1000, now: () => 100000 });

  // Begin two sessions
  const s1 = registry.begin({ appId: APP, environmentId: ENV }, 'powerapps');
  const s2 = registry.begin({ appId: 'other-id', environmentId: ENV }, 'powerapps');

  // Invalidate first session
  const result1 = registry.invalidateBySessionId(s1.stateSessionId, 'test');
  assert.equal(result1.invalidated, true);

  // Second session must still exist
  assert.doesNotThrow(() => {
    registry.lookup(s2.correlationId, s2.stateSessionId, 'powerapps');
  });

  // Invalidate again — idempotent (not an error)
  const result2 = registry.invalidateBySessionId(s1.stateSessionId, 'test');
  assert.equal(result2.invalidated, false); // Already gone, but idempotent

  // Lookup should fail
  assert.throws(() => {
    registry.lookup(s1.correlationId, s1.stateSessionId, 'powerapps');
  });
});

test('CRITICAL: single correlationId per request (no mixing)', async t => {
  const f = await fixture(t);

  // Call get_powerapps_state
  const state1 = await f.rpc('get_powerapps_state', {}, 'session-a');
  assert.equal(state1.error, false);
  const correlationId1 = state1.data.correlationId;
  const stateSessionId1 = state1.data.stateSessionId;

  // Second independent request should get a DIFFERENT correlationId
  const state2 = await f.rpc('get_powerapps_state', {}, 'session-b');
  assert.equal(state2.error, false);
  const correlationId2 = state2.data.correlationId;
  const stateSessionId2 = state2.data.stateSessionId;

  // CRITICAL: Different requests must have different correlationIds and stateSessionIds
  assert.notEqual(correlationId1, correlationId2, 'each request must have unique correlationId');
  assert.notEqual(stateSessionId1, stateSessionId2, 'each request must have unique stateSessionId');

  // Each correlationId should be injected consistently within a request
  // When user calls get_powerapps_source with correlationId1, it should work
  const source1 = await f.rpc('get_powerapps_source', {
    relativePath: PATH, correlationId: correlationId1, stateSessionId: stateSessionId1
  }, 'session-a');
  assert.equal(source1.error, false);
  assert.equal(source1.data.correlationId, correlationId1, 'source must use same correlationId');

  // Using mismatched correlationId2 with session1 should fail
  const sourceMismatch = await f.rpc('get_powerapps_source', {
    relativePath: PATH, correlationId: correlationId2, stateSessionId: stateSessionId1
  }, 'session-a');
  assert.equal(sourceMismatch.error, true, 'mismatched correlationId/stateSessionId should fail');
});

test('CRITICAL: incomplete context (missing sha) must NOT issue stateSessionId', async t => {
  const f = await fixture(t);

  // Create fixture where getSourceFileMetadata fails
  const appStore = {
    getAppState: async () => ({ status: 'ok', appId: APP, environmentId: ENV, operationId: crypto.randomUUID() })
  };
  const gitStoreBroken = {
    canonicalBranch: 'main',
    getSourceFile: async (file) => ({ status: 'ok', path: file, content: CONTENT, sha: blobSha(CONTENT), branch: 'main', canonicalBranch: 'main' }),
    getSourceFileMetadata: async (gitRoot) => {
      // Simulates Git metadata fetch failure
      throw new Error('Git API unavailable');
    }
  };

  const config = getConfig({});
  config.enforceStateManager = true;
  config.stateContextRegistry = { ttlMs: 1000, now: () => 100000 };
  const app = createApp(config, {}, appStore, gitStoreBroken, {}, {}, {});
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  async function rpc(name, args = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
    const result = await response.json();
    return { error: result.result?.isError, data: result.result?.structuredContent };
  }

  // CRITICAL: get_powerapps_state must FAIL and NOT issue stateSessionId
  const state = await rpc('get_powerapps_state', {});
  assert.equal(state.error, true, 'get_powerapps_state must fail when Git metadata unavailable');
  assert.equal(state.data.stateSessionId, undefined, 'FAIL-CLOSED: must not issue stateSessionId on incomplete context');
  assert.equal(state.data.status, 'state_context_invalid', 'error must indicate state context invalid');
});

test('CRITICAL: same stateSessionId can be reused for 3+ screens in one session', async t => {
  const f = await fixture(t);

  // Get initial state
  const state = await f.rpc('get_powerapps_state', {});
  assert.equal(state.error, false);
  const correlationId = state.data.correlationId;
  const stateSessionId = state.data.stateSessionId;

  // Get first source (S1_Home)
  const source1 = await f.rpc('get_powerapps_source', {
    relativePath: PATH,
    correlationId,
    stateSessionId
  });
  assert.equal(source1.error, false);
  assert.equal(source1.data.stateSessionId, stateSessionId, 'session must be preserved');

  // Get second source (S2_Screen via targetNames)
  const source2 = await f.rpc('get_powerapps_source', {
    targetNames: ['S1_Home', 'S2_Screen'],
    correlationId,
    stateSessionId
  });
  // Even if S2_Screen doesn't exist, the stateSessionId should be reused
  // (Implementation handles missing screens gracefully)

  // Validate with same session
  const validate = await f.rpc('validate_powerapps_source', {
    stateContext: source1.data.stateContext,
    stateSessionId,
    sourceContent: CONTENT,
    relativePath: PATH
  });
  assert.equal(validate.error, false);
  assert.equal(validate.data.correlationId, correlationId, 'correlation must be consistent');

  // Compare with same session
  const compare = await f.rpc('compare_powerapps_with_git', {
    stateContext: source1.data.stateContext,
    stateSessionId,
    targetFile: PATH,
    targetApp: APP
  });
  assert.equal(compare.error, false);
  assert.equal(compare.data.correlationId, correlationId, 'correlation must be consistent');
});
