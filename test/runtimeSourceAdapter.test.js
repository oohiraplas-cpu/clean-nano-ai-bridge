const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { PowerAppsRuntimeSourceAdapter } = require('../src/powerAppsRuntimeSource');
const { compareSources } = require('../src/sourceComparison');
const { StateContextRegistry, blobSha } = require('../src/stateContext');
const { PowerAppsStore } = require('../src/powerAppsStore');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');

const APP = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
const ENV = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const FILE = 'powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml';
const ENTRY = 'Src/S1_Home.pa.yaml';
const SOURCE = 'Screens:\n  S1_Home:\n    Properties:\n      Fill: =Color.White\n      Visible: =true\n';
const CONFIG = { mode: 'pac', appId: APP, environmentId: ENV, canonicalBranch: 'main', sourceMap: { [FILE]: ENTRY } };

function registered() {
  let now = 100;
  const registry = new StateContextRegistry({ now: () => now, ttlMs: 1000 });
  const started = registry.begin({ appId: APP, environmentId: ENV, branch: 'main', canonicalBranch: 'main' }, 'session-a');
  const bound = registry.bind(started.correlationId, started.stateSessionId, 'session-a', {
    path: FILE, content: SOURCE, sha: blobSha(SOURCE)
  }, FILE);
  function options(context = bound.stateContext, scope = 'session-a') {
    return { stateContext: context, assertStateContext: () => registry.validate(context, bound.stateSessionId, scope, { targetFile: FILE }, 'compare_powerapps_with_git') };
  }
  return { bound, options, expire: () => { now += 1001; } };
}
const exported = (request, content = SOURCE) => ({ status: 'ok', appId: request.appId, environment: request.environment, entry: request.entry, content, encoding: 'utf-8' });

test('read-only adapter uses registered identity and exact configured source entry', async () => {
  const f = registered();
  let calls = 0;
  const adapter = new PowerAppsRuntimeSourceAdapter(CONFIG, async (_, request) => {
    calls++;
    assert.equal(request.appId, APP); assert.equal(request.environment, ENV); assert.equal(request.entry, ENTRY);
    return exported(request);
  });
  const source = await adapter.getSourceFile(FILE, f.options());
  assert.equal(calls, 1); assert.equal(source.content, SOURCE);
  assert.equal(source.gitSha, f.bound.stateContext.sha);
  assert.equal(source.correlationId, f.bound.correlationId);
  assert.equal(source.source, 'power-apps-saved-msapp');
});

for (const field of ['appId', 'environment', 'branch', 'canonicalBranch', 'sha', 'correlationId']) {
  test(`runtime reader rejects missing/mismatched ${field} before export`, async () => {
    const f = registered(); let reads = 0;
    const adapter = new PowerAppsRuntimeSourceAdapter(CONFIG, async () => { reads++; });
    for (const missing of [true, false]) {
      const context = { ...f.bound.stateContext };
      if (missing) delete context[field];
      else context[field] = field === 'sha' ? '0'.repeat(40) : field === 'correlationId' ? crypto.randomUUID() : 'other';
      await assert.rejects(adapter.getSourceFile(FILE, f.options(context)), error => error.payload.status === 'state_context_invalid');
    }
    assert.equal(reads, 0);
  });
}
test('runtime reader rejects expired and cross-session context, including expiry during export', async () => {
  const f = registered(); let reads = 0;
  const adapter = new PowerAppsRuntimeSourceAdapter(CONFIG, async (_, request) => { reads++; f.expire(); return exported(request); });
  await assert.rejects(adapter.getSourceFile(FILE, f.options(undefined, 'session-b')), /session mismatch/);
  assert.equal(reads, 0);
  await assert.rejects(adapter.getSourceFile(FILE, f.options()), /expired/);
  await assert.rejects(adapter.getSourceFile(FILE, f.options()), /not registered/);
  assert.equal(reads, 1);
});
test('adapter unset, missing mapping, missing PAC and failed reads are source_unavailable without diagnostics', async () => {
  const f = registered();
  for (const config of [{ ...CONFIG, mode: '' }, { ...CONFIG, sourceMap: {} }]) {
    await assert.rejects(new PowerAppsRuntimeSourceAdapter(config, async () => assert.fail('must not export')).getSourceFile(FILE, f.options()), error => error.payload.comparisonStatus === 'source_unavailable');
  }
  const adapter = new PowerAppsRuntimeSourceAdapter(CONFIG, async () => { throw new Error('Bearer sensitive-authentication-value https://private-connection/'); });
  await assert.rejects(adapter.getSourceFile(FILE, f.options()), error => {
    assert.doesNotMatch(JSON.stringify(error.payload) + error.message, /Bearer|private-connection|sensitive/);
    return error.payload.comparisonStatus === 'source_unavailable';
  });
  const missingWorker = new PowerAppsRuntimeSourceAdapter({ ...CONFIG, pythonExecutable: '/nonexistent/bridge-python' });
  await assert.rejects(missingWorker.getSourceFile(FILE, f.options()), error => error.payload.comparisonStatus === 'source_unavailable');
});
test('runtime reader rejects a mismatched observed app/environment/entry', async () => {
  for (const field of ['appId', 'environment', 'entry']) {
    const f = registered();
    const adapter = new PowerAppsRuntimeSourceAdapter(CONFIG, async (_, request) => ({ ...exported(request), [field]: 'other' }));
    await assert.rejects(adapter.getSourceFile(FILE, f.options()), error => error.payload.comparisonStatus === 'validation_blocked');
  }
});
test('adapter cannot run without the trusted registered-context callback', async () => {
  await assert.rejects(new PowerAppsRuntimeSourceAdapter(CONFIG).getSourceFile(FILE, { stateContext: registered().bound.stateContext }), error => error.payload.comparisonStatus === 'validation_blocked');
});
test('worker-controlled errors cannot pass diagnostics through a comparison payload', async () => {
  const f = registered();
  const adapter = new PowerAppsRuntimeSourceAdapter(CONFIG, async () => {
    const error = new Error('Bearer hidden-authentication-value');
    error.payload = { comparisonStatus: 'source_unavailable', reason: 'private-connection-url', token: 'hidden-token' };
    throw error;
  });
  await assert.rejects(adapter.getSourceFile(FILE, f.options()), error => {
    assert.equal(error.payload.reason, 'source_read_failed');
    assert.doesNotMatch(JSON.stringify(error.payload) + error.message, /hidden|private|Bearer/);
    return true;
  });
});

test('normalization removes BOM, line endings, comments and mapping key order only', () => {
  const formatted = '\uFEFF# comment\r\nScreens:\r\n  S1_Home:\r\n    Properties:\r\n      Visible: =true\r\n      Fill: "=Color.White"\r\n';
  const same = compareSources(SOURCE, SOURCE, FILE);
  assert.equal(same.comparisonStatus, 'identical'); assert.equal(same.presentationOnly, false);
  const diff = compareSources(SOURCE, formatted, FILE);
  assert.equal(diff.comparisonStatus, 'identical'); assert.equal(diff.presentationOnly, true);
  assert.deepEqual(diff.changedProperties, []); assert.deepEqual(diff.changedLines.git, []);
});
test('substantive differences return file, property paths and actual changed line numbers without values', () => {
  const diff = compareSources(SOURCE, SOURCE.replace('Color.White', 'Color.Black'), FILE);
  assert.equal(diff.comparisonStatus, 'changed'); assert.equal(diff.targetFile, FILE);
  assert.deepEqual(diff.changedProperties, [{ property: '/Screens/S1_Home/Properties/Fill', kind: 'changed' }]);
  assert.deepEqual(diff.changedLines.git, [4]); assert.deepEqual(diff.changedLines.powerApps, [4]);
  assert.doesNotMatch(JSON.stringify(diff), /Color.White|Color.Black/);
});
test('array order, scalar type and formula whitespace remain substantive', () => {
  for (const [before, after] of [['Controls: [A, B]', 'Controls: [B, A]'], ['Value: 1', 'Value: "1"'], ['Formula: =A + B', 'Formula: =A+B']]) {
    assert.equal(compareSources(before, after, FILE).comparisonStatus, 'changed');
  }
});
test('ambiguous duplicate keys, invalid YAML and cyclic aliases fail normalization', () => {
  for (const source of ['a: 1\na: 2', 'a: [', 'a: &a\n  x: *a', 'a: .nan', 'a: 9007199254740993']) assert.throws(() => compareSources(SOURCE, source, FILE));
});

async function mcpFixture(t, options = {}) {
  let now = 100;
  const config = getConfig({}); config.enforceStateManager = true;
  config.stateContextRegistry = { now: () => now, ttlMs: 1000 };
  const state = { status: 'ok', appId: APP, environmentId: ENV };
  const source = { status: 'ok', path: FILE, content: SOURCE, sha: blobSha(SOURCE), branch: 'main', canonicalBranch: 'main' };
  let exports = 0, gitReads = 0;
  const store = new PowerAppsStore({ appId: APP, environmentId: ENV, githubBranch: 'main', runtimeSource: { ...CONFIG, ...(options.unset ? { mode: '' } : {}) },
    runtimeSourceWorker: async (_, request) => {
      exports++;
      if (options.drift) source.sha = '0'.repeat(40);
      if (options.expire) now += 1001;
      if (options.unavailable) throw new Error('secret-private-diagnostics');
      return exported(request, options.content ?? SOURCE);
    } });
  store.getAppState = async () => ({ ...state, operationId: crypto.randomUUID() });
  const gitStore = {
    canonicalBranch: 'main',
    getSourceFile: async file => { gitReads++; assert.equal(file, FILE); return { ...source }; },
    getSourceFileMetadata: async (gitRoot) => {
      return {
        branch: 'main',
        canonicalBranch: 'main',
        sha: blobSha(SOURCE)
      };
    }
  };
  const app = createApp(config, {}, store, gitStore, {}, {}, {});
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function call(name, args = {}, session = 'session-a') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'Mcp-Session-Id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json(); return body.result;
  }
  async function chain() {
    assert.equal((await call('health_check')).isError, false);
    const a = (await call('get_powerapps_state')).structuredContent;
    const b = (await call('get_powerapps_source', { relativePath: FILE, correlationId: a.correlationId, stateSessionId: a.stateSessionId })).structuredContent;
    assert.equal(b.stateContextComplete, true);
    const args = { stateContext: b.stateContext, stateSessionId: b.stateSessionId };
    assert.equal((await call('validate_powerapps_source', args)).structuredContent.validationStatus, 'VALID');
    return args;
  }
  return { chain, call, counts: () => ({ exports, gitReads }) };
}
test('MCP chain exports actual adapter source, fetches canonical Git, validates and compares', async t => {
  const f = await mcpFixture(t); const args = await f.chain();
  const result = await f.call('compare_powerapps_with_git', { ...args, targetFile: FILE, targetApp: APP });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.comparisonStatus, 'identical');
  assert.equal(result.structuredContent.comparisonVerified, true);
  assert.equal(result.structuredContent.targetSha, args.stateContext.sha);
  assert.equal(result.structuredContent.correlationId, args.stateContext.correlationId);
  assert.equal(f.counts().exports, 1); assert.ok(f.counts().gitReads >= 3);
});
test('MCP reports changed, presentation-only, unavailable and validation_blocked outcomes', async t => {
  for (const [options, outcome, isError] of [
    [{ content: SOURCE.replace('Color.White', 'Color.Black') }, 'changed', false],
    [{ content: '# display only\n' + SOURCE }, 'identical', false],
    [{ unavailable: true }, 'source_unavailable', true],
    [{ unset: true }, 'source_unavailable', true],
    [{ expire: true }, 'validation_blocked', true],
    [{ drift: true }, 'validation_blocked', true],
    [{ content: 'broken: [' }, 'validation_blocked', true]
  ]) {
    const f = await mcpFixture(t, options);
    const result = await f.call('compare_powerapps_with_git', await f.chain());
    assert.equal(result.isError, isError); assert.equal(result.structuredContent.comparisonStatus, outcome);
    assert.doesNotMatch(JSON.stringify(result), /secret-private-diagnostics/);
  }
});
test('MCP cross-session comparison is validation_blocked before runtime export', async t => {
  const f = await mcpFixture(t); const result = await f.call('compare_powerapps_with_git', await f.chain(), 'session-b');
  assert.equal(result.isError, true); assert.equal(result.structuredContent.comparisonStatus, 'validation_blocked');
  assert.equal(f.counts().exports, 0);
});
test('PAC worker archive and subprocess tests pass', () => {
  const output = execFileSync(process.env.POWERAPPS_RUNTIME_PYTHON || 'python3', [path.join(__dirname, 'runtime_source_worker_test.py')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(output, /worker tests passed/);
});


test('adapter forwards observed Windows archive entry exactly and rejects unsafe paths', async () => {
  const { PowerAppsRuntimeSourceAdapter } = require('../src/powerAppsRuntimeSource');
  const context = { appId: APP, environment: ENV, branch: 'main', canonicalBranch: 'main', sha: 'a'.repeat(40), correlationId: 'observed-id' };
  const entry = 'Src\\S1_Home.pa.yaml';
  const adapter = new PowerAppsRuntimeSourceAdapter({ ...CONFIG, sourceMap: { [FILE]: entry } }, async (_, request) => {
    assert.equal(request.entry, entry);
    return { status: 'ok', appId: APP, environment: ENV, entry, content: 'Screens: {}' };
  });
  const result = await adapter.getSourceFile(FILE, { stateContext: context, assertStateContext() {} });
  assert.equal(result.content, 'Screens: {}');
  for (const unsafe of ['Src/../Home.pa.yaml', 'Src/./Home.pa.yaml', 'Src//Home.pa.yaml', 'Src\\..\\Home.pa.yaml']) {
    const blocked = new PowerAppsRuntimeSourceAdapter({ ...CONFIG, sourceMap: { [FILE]: unsafe } }, () => { throw new Error('must not run'); });
    await assert.rejects(blocked.getSourceFile(FILE, { stateContext: context, assertStateContext() {} }), error => error.payload.reason === 'source_mapping_not_configured');
  }
});


test('PAC worker identity is isolated from inherited service principal credentials', () => {
  const { pacWorkerEnvironment } = require('../src/powerAppsRuntimeSource');
  const parent = { PATH: '/usr/bin', AZURE_CLIENT_ID: 'old-spn', AZURE_CLIENT_SECRET: 'secret',
    AZURE_TENANT_ID: 'old-tenant', AZURE_FEDERATED_TOKEN_FILE: '/private/token',
    AZURE_USERNAME: 'developer', HOME: '/shared' };
  const env = pacWorkerEnvironment({ authMode: 'managedIdentity', pacProfileHome: '/dedicated/pac' }, parent);
  assert.equal(env.HOME, '/dedicated/pac');
  assert.equal(env.AZURE_TOKEN_CREDENTIALS, 'ManagedIdentityCredential');
  for (const key of ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID',
    'AZURE_FEDERATED_TOKEN_FILE', 'AZURE_USERNAME']) assert.equal(env[key], undefined);
});

test('PAC worker fails closed without explicit identity and dedicated profile', () => {
  const { pacWorkerEnvironment } = require('../src/powerAppsRuntimeSource');
  for (const config of [{}, { authMode: 'managedIdentity' },
    { authMode: 'managedIdentity', pacProfileHome: 'relative/path' },
    { authMode: 'managedIdentity', pacProfileHome: '/pac', managedIdentityClientId: 'not-a-guid' }]) {
    assert.throws(() => pacWorkerEnvironment(config), error => error.payload?.status === 'source_unavailable');
  }
});
