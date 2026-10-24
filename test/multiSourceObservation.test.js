const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');
const { StateContextRegistry, blobSha } = require('../src/stateContext');

const ROOT = 'powerapps/test/Source';
const COMMIT = 'a'.repeat(40);
const SCOPE = 'authenticated-test-scope';
const file = (name, content = `Screens:\n  ${name}:\n`) => ({
  status: 'ok', path: `${ROOT}/${name}.pa.yaml`, content, sha: blobSha(content),
  branch: 'main', canonicalBranch: 'main'
});

async function fixture(t, options = {}) {
  let now = 100000;
  let reads = 0;
  const files = Object.fromEntries(['A', 'B', 'C'].map(name => [`${name}.pa.yaml`, file(name)]));
  const git = {
    getSourceFileMetadata: async () => ({ branch: 'main', canonicalBranch: 'main', sha: COMMIT }),
    resolveTargetNamesToFiles: async names => options.resolve ? options.resolve(names, files) : ({
      results: names.map(name => ({ name, path: `${name}.pa.yaml`, sha: files[`${name}.pa.yaml`]?.sha, branch: 'main' })), errors: []
    }),
    getSourceFile: async path => {
      reads++;
      const found = files[path.replace(`${ROOT}/`, '')];
      if (!found) throw new Error('file not found');
      return options.read ? options.read(path, { ...found }, reads) : { ...found };
    }
  };
  const config = getConfig({});
  config.powerApps.githubRoot = ROOT;
  config.powerApps.githubRepo = 'test-repo';
  config.enforceStateManager = options.enforce !== false;
  config.mcpApiKey = 'local-test-key';
  config.stateContextRegistry = { ttlMs: 1000, now: () => now };
  const app = createApp(config, {}, {
    getAppState: async () => ({ status: 'ok', appId: 'test-app', environmentId: 'test-env' })
  }, git, {}, {}, {});
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function rpc(name, args = {}, session = 'session-a', transport = 'tools') {
    const body = transport === 'legacy' ? { method: name, params: args }
      : transport === 'direct' ? { jsonrpc: '2.0', id: 1, method: name, params: args }
      : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'local-test-key', 'Mcp-Session-Id': session },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (transport === 'legacy') return { error: !res.ok, data: res.ok ? json.result : json };
    if (transport === 'direct') return { error: !!json.error, data: json.error?.data || json.result };
    return { error: json.result?.isError, data: json.result?.structuredContent };
  }
  async function begin(transport = 'tools') {
    const result = await rpc('get_powerapps_state', {}, 'session-a', transport);
    assert.equal(result.error, false);
    return { correlationId: result.data.correlationId, stateSessionId: result.data.stateSessionId };
  }
  return { rpc, begin, files, get reads() { return reads; }, expire: () => { now += 1001; } };
}

for (const transport of ['tools', 'direct', 'legacy']) {
  test(`state -> three verified screens succeeds on ${transport} transport`, async t => {
    const f = await fixture(t);
    const state = await f.begin(transport);
    const result = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B', 'C'] }, 'session-a', transport);
    assert.equal(result.error, false);
    assert.equal(result.data.status, 'ok');
    assert.equal(result.data.stateSessionId, state.stateSessionId);
    assert.equal(result.data.stateContextComplete, true);
    assert.equal(result.data.sourceObservationComplete, true);
    assert.equal(result.data.stateContext.sha, COMMIT, 'commit authority must remain unchanged');
    assert.equal(result.data.result.successCount, 3);
    assert.equal(result.data.result.errorCount, 0);
    assert.deepEqual(result.data.result.sourceObservations.map(o => o.fileSha), ['A', 'B', 'C'].map(n => f.files[`${n}.pa.yaml`].sha));
  });
  test(`partial resolution is an error on ${transport} transport`, async t => {
    const f = await fixture(t, { resolve: (names, files) => ({
      results: [{ name: 'A', path: 'A.pa.yaml', sha: files['A.pa.yaml'].sha }],
      errors: [{ name: 'B', error: 'FILE_NOT_FOUND', reason: 'not found' }]
    }) });
    const state = await f.begin(transport);
    const result = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] }, 'session-a', transport);
    assert.equal(result.error, true);
    assert.equal(result.data.stateContextComplete, false);
    assert.equal(result.data.result.successCount, 0);
    assert.ok(result.data.result.errorCount > 0);
    assert.equal(f.reads, 0, 'must not bind or fetch a known incomplete batch');
  });
}

const failures = {
  'first fetch fails': { read: (path, source) => { if (path === 'A.pa.yaml') throw new Error('unavailable'); return source; } },
  'second fetch fails': { read: (path, source) => { if (path === 'B.pa.yaml') throw new Error('unavailable'); return source; } },
  'content hash differs': { read: (path, source) => ({ ...source, content: source.content + 'changed' }) },
  'retrieved SHA missing': { read: (path, source) => ({ ...source, sha: undefined }) },
  'retrieved SHA malformed': { read: (path, source) => ({ ...source, sha: 'invalid' }) },
  'resolved SHA missing': { resolve: names => ({ results: names.map(name => ({ name, path: `${name}.pa.yaml` })), errors: [] }) },
  'resolved SHA drifts': { resolve: names => ({ results: names.map(name => ({ name, path: `${name}.pa.yaml`, sha: 'b'.repeat(40) })), errors: [] }) },
  'content missing': { read: (path, source) => ({ ...source, content: null }) },
  'canonical path differs': { read: (path, source) => ({ ...source, path: `${ROOT}/Other.pa.yaml` }) },
  'branch differs': { read: (path, source) => ({ ...source, branch: 'fallback' }) },
  'canonical branch differs': { read: (path, source) => ({ ...source, canonicalBranch: 'other' }) },
  'resolver throws': { resolve: () => { throw new Error('resolution unavailable'); } },
  'all resolutions fail': { resolve: names => ({ results: [], errors: names.map(name => ({ name, error: 'FILE_NOT_FOUND' })) }) },
  'one result omitted': { resolve: (names, files) => ({ results: [{ name: 'A', path: 'A.pa.yaml', sha: files['A.pa.yaml'].sha }], errors: [] }) },
  'duplicate result names': { resolve: (names, files) => ({ results: names.map(() => ({ name: 'A', path: 'A.pa.yaml', sha: files['A.pa.yaml'].sha })), errors: [] }) },
  'unexpected result name': { resolve: (names, files) => ({ results: names.map(name => ({ name: name === 'B' ? 'C' : name, path: `${name}.pa.yaml`, sha: files[`${name}.pa.yaml`].sha })), errors: [] }) },
  'duplicate canonical paths': { resolve: (names, files) => ({ results: names.map(name => ({ name, path: 'A.pa.yaml', sha: files['A.pa.yaml'].sha })), errors: [] }) }
};
for (const [name, options] of Object.entries(failures)) {
  test(`batch fails closed and invalidates only its session: ${name}`, async t => {
    const f = await fixture(t, options);
    const state = await f.begin();
    const other = await f.begin();
    const result = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] });
    assert.equal(result.error, true);
    assert.equal(result.data.status, 'state_context_invalid');
    assert.equal(result.data.stateContextComplete, false);
    assert.equal(result.data.stateSessionId, undefined);
    assert.deepEqual(result.data.result.sourceObservations, []);
    const retry = await f.rpc('get_powerapps_source', { ...state, relativePath: 'C.pa.yaml' });
    assert.equal(retry.error, true);
    assert.match(retry.data.error, /not registered/);
    const isolated = await f.rpc('get_powerapps_source', { ...other, relativePath: 'C.pa.yaml' });
    // The other session survives even when its independent source verification fails.
    assert.doesNotMatch(isolated.data.error || '', /not registered/);
  });
}

test('non-enforcement mode still returns bound context for a valid batch', async t => {
  const f = await fixture(t, { enforce: false });
  const state = await f.begin();
  const result = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] });
  assert.equal(result.error, false);
  assert.equal(result.data.stateSessionId, state.stateSessionId);
  assert.equal(result.data.stateContextComplete, true);
});

test('wrong transport scope cannot bind or invalidate a valid session', async t => {
  const f = await fixture(t);
  const state = await f.begin();
  const denied = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] }, 'different-session');
  assert.equal(denied.error, true);
  assert.equal(f.reads, 0);
  const valid = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] });
  assert.equal(valid.error, false);
});

test('expired session cannot read or bind a batch', async t => {
  const f = await fixture(t);
  const state = await f.begin();
  f.expire();
  const denied = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] });
  assert.equal(denied.error, true);
  assert.match(denied.data.error, /expired/);
  assert.equal(f.reads, 0);
});

test('a partial failure invalidates previously successful observations', async t => {
  const f = await fixture(t, { read: (path, source) => { if (path === 'B.pa.yaml') throw new Error('failed'); return source; } });
  const state = await f.begin();
  assert.equal((await f.rpc('get_powerapps_source', { ...state, relativePath: 'A.pa.yaml' })).data.stateContextComplete, true);
  assert.equal((await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] })).error, true);
  const retry = await f.rpc('get_powerapps_source', { ...state, relativePath: 'A.pa.yaml' });
  assert.equal(retry.error, true);
  assert.match(retry.data.error, /not registered/);
});

test('Registry retains A and B and rejects A SHA drift after binding B', () => {
  const registry = new StateContextRegistry();
  const s = registry.begin({ appId: 'test-app', environmentId: 'test-env' }, SCOPE);
  for (const name of ['A', 'B']) registry.bindSourceObservation(s.correlationId, s.stateSessionId, SCOPE, file(name), `${name}.pa.yaml`);
  const record = registry.lookup(s.correlationId, s.stateSessionId, SCOPE);
  assert.equal(record.sources.size, 2);
  assert.equal(record.source.path, file('B').path, 'legacy last-source view retained');
  assert.throws(() => registry.bindSourceObservation(s.correlationId, s.stateSessionId, SCOPE, file('A', 'changed'), 'A.pa.yaml'), /different SHA/);
  assert.equal(record.sources.get(file('A').path).sha, file('A').sha);
});

test('Registry retains a legacy bind when a later observation uses another path', () => {
  const registry = new StateContextRegistry();
  const s = registry.begin({ appId: 'test-app', environmentId: 'test-env' }, SCOPE);
  registry.bind(s.correlationId, s.stateSessionId, SCOPE, file('A'), 'A.pa.yaml');
  registry.bindSourceObservation(s.correlationId, s.stateSessionId, SCOPE, file('B'), 'B.pa.yaml');
  assert.throws(() => registry.bindSourceObservation(s.correlationId, s.stateSessionId, SCOPE, file('A', 'changed'), 'A.pa.yaml'), /different SHA/);
});

test('Registry still rejects a different process, wrong session, bad hash, and noncanonical paths', () => {
  const registry = new StateContextRegistry();
  const s = registry.begin({ appId: 'test-app', environmentId: 'test-env' }, SCOPE);
  assert.throws(() => new StateContextRegistry().lookup(s.correlationId, s.stateSessionId, SCOPE), /not registered/);
  assert.throws(() => registry.lookup(s.correlationId, 'wrong-session', SCOPE), /session mismatch/);
  assert.throws(() => registry.bindSourceObservation(s.correlationId, s.stateSessionId, SCOPE, { ...file('A'), sha: 'b'.repeat(40) }, 'A.pa.yaml'), /blob SHA/);
  for (const path of ['../A', 'x/../A', '/A', 'x//A', 'x/./A', 'x\\A']) {
    assert.throws(() => registry.bindSourceObservation(s.correlationId, s.stateSessionId, SCOPE, { ...file('A'), path }, path), /canonical relative path/);
  }
});

for (const targetNames of [[], ['A', 'A'], Array.from({ length: 51 }, (_, i) => `S${i}`)]) {
  test(`invalid target list never succeeds: ${targetNames.length} entries`, async t => {
    const f = await fixture(t);
    const state = await f.begin();
    const denied = await f.rpc('get_powerapps_source', { ...state, targetNames, relativePath: 'A.pa.yaml' });
    assert.equal(denied.error, true);
    assert.equal(f.reads, 0);
    assert.notEqual(denied.data.stateContextComplete, true);
  });
}

test('missing or mismatched session cannot read a batch', async t => {
  const f = await fixture(t);
  const state = await f.begin();
  for (const args of [{}, { correlationId: state.correlationId }, { ...state, stateSessionId: 'incorrect-session' }]) {
    assert.equal((await f.rpc('get_powerapps_source', { ...args, targetNames: ['A', 'B'] })).error, true);
  }
  assert.equal(f.reads, 0);
  assert.equal((await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] })).error, false);
});

test('empty file content with a verified SHA can be observed', async t => {
  const f = await fixture(t);
  f.files['A.pa.yaml'] = file('A', '');
  const state = await f.begin();
  const result = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] });
  assert.equal(result.error, false);
  assert.equal(result.data.result.successCount, 2);
});

test('expiry during asynchronous reads cannot produce a successful batch', async t => {
  let expire;
  const f = await fixture(t, { read: (path, source) => { if (path === 'B.pa.yaml') expire(); return source; } });
  expire = f.expire;
  const state = await f.begin();
  const result = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] });
  assert.equal(result.error, true);
  assert.equal(result.data.result.successCount, 0);
  assert.equal(result.data.stateContextComplete, false);
});

test('A SHA drift after a successful A/B batch invalidates the whole session', async t => {
  const f = await fixture(t);
  const state = await f.begin();
  assert.equal((await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'B'] })).error, false);
  f.files['A.pa.yaml'] = file('A', 'changed but internally consistent');
  const result = await f.rpc('get_powerapps_source', { ...state, targetNames: ['A', 'C'] });
  assert.equal(result.error, true);
  assert.equal(result.data.result.successCount, 0);
  assert.equal((await f.rpc('get_powerapps_source', { ...state, relativePath: 'B.pa.yaml' })).error, true);
});
