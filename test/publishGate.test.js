const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { getConfig } = require('../src/config');
const { createApp } = require('../src/server');
const { blobSha } = require('../src/stateContext');

// Publish gate (contract 2026-10-11). Commit SHA and blob SHA are deliberately different values.
const APP = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
const ENV = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const PATH = 'powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml';
const CONTENT = 'Screens:\n  S1_Home:\n    Properties:\n      Fill: =Color.White\n';
const COMMIT = '3e5bad3fc1a8a58ad7e64f81124a8edc5f2be9a7';
const OTHER_COMMIT = '7dcb8faf9d440e0187e8f29c824014d8efedbe4c';
const BLOB = blobSha(CONTENT);
const OTHER_BLOB = blobSha('changed content\n');
const MCP_KEY = 'mcp-test-key';

async function fixture(t, options = {}) {
  let now = 100000;
  const state = { appId: APP, environmentId: ENV };
  const git = { branch: 'main', canonicalBranch: 'main', commit: COMMIT, blob: BLOB };
  const publishCalls = [];
  const appStore = {
    getAppState: async () => ({ ...state, operationId: crypto.randomUUID() }),
    getAppInfo: async () => ({ id: APP, name: 'Test App', environmentId: ENV, screenCount: 1, screens: [{ name: 'S1_Home' }] }),
    publishApp: async () => { publishCalls.push(Date.now()); return { status: 'ok', operationId: crypto.randomUUID() }; }
  };
  const gitStore = {
    canonicalBranch: 'main',
    assertCanonicalBranch: async (branch) => {
      if (branch !== undefined && branch !== 'main') {
        const error = new Error('branch mismatch');
        error.status = 409;
        error.payload = { status: 'branch_mismatch' };
        throw error;
      }
    },
    getSourceFile: async (file) => ({ path: PATH, content: CONTENT, sha: git.blob, branch: git.branch, canonicalBranch: 'main' }),
    getSourceFileMetadata: async () => ({ branch: git.branch, canonicalBranch: 'main', sha: git.commit })
  };
  const config = getConfig({});
  config.enforceStateManager = true;
  config.mcpApiKey = MCP_KEY;
  config.deploymentSha = options.deploymentSha === undefined ? COMMIT : options.deploymentSha;
  config.stateContextRegistry = { ttlMs: 1000, now: () => now };
  const app = createApp(config, {}, appStore, gitStore, {}, {}, {});
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  async function rpc(name, args = {}, { session = 'session-a', key = MCP_KEY } = {}) {
    const headers = { 'content-type': 'application/json', 'Mcp-Session-Id': session };
    if (key) headers['x-api-key'] = key;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    if (response.status === 401) return { status: 401 };
    const result = await response.json();
    return { status: response.status, error: result.result?.isError, data: result.result?.structuredContent };
  }

  // Observe the canonical source in a state session (the only path that binds a source).
  async function observedSession() {
    const a = await rpc('get_powerapps_state');
    assert.equal(a.error, false);
    const b = await rpc('get_powerapps_source', { relativePath: PATH, correlationId: a.data.correlationId, stateSessionId: a.data.stateSessionId });
    assert.equal(b.error, false);
    assert.equal(b.data.stateContextComplete, true);
    return { stateContext: b.data.stateContext, stateSessionId: b.data.stateSessionId, correlationId: b.data.correlationId };
  }

  async function publish(extra = {}, session) {
    const args = { branch: 'main', ...extra };
    if (session !== undefined) Object.assign(args, session);
    return rpc('publish_powerapps_app', args);
  }

  return { rpc, publish, observedSession, state, git, publishCalls, config, expire: () => { now += 1001; }, url };
}

test('MCP認証なしは401（公開ゲート以前に拒否）', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  const res = await f.rpc('publish_powerapps_app', { branch: 'main', ...session }, { key: null });
  assert.equal(res.status, 401);
  assert.equal(f.publishCalls.length, 0);
});

test('stateSessionIdなしは明示的に拒否し、公開APIを呼ばない', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  const res = await f.publish({ stateContext: session.stateContext });
  assert.equal(res.error, true);
  assert.equal(res.data.status, 'state_session_required');
  assert.equal(f.publishCalls.length, 0);
});

test('期限切れsessionは拒否する', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  f.expire();
  const res = await f.publish({ stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(res.error, true);
  assert.equal(f.publishCalls.length, 0);
});

test('source未観測sessionは拒否する（state readのみ）', async (t) => {
  const f = await fixture(t);
  const a = await f.rpc('get_powerapps_state');
  assert.equal(a.data.stateContextComplete, false);
  const res = await f.publish({ stateContext: a.data.stateContext, stateSessionId: a.data.stateSessionId });
  assert.equal(res.error, true);
  assert.equal(f.publishCalls.length, 0);
});

test('commit SHA不一致（正本commitが変化）は拒否する', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  f.git.commit = OTHER_COMMIT;
  const res = await f.publish({ stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(res.error, true);
  assert.equal(res.data.status, 'publish_gate_refused');
  assert.equal(f.publishCalls.length, 0);
});

test('blob SHA変更（観測ファイルが変化）は拒否する', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  f.git.blob = OTHER_BLOB;
  const res = await f.publish({ stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(res.error, true);
  assert.ok(res.data.failures.some(x => x.startsWith('sha: 観測ソースのblob')));
  assert.equal(f.publishCalls.length, 0);
});

test('App ID不一致は公開直前に拒否する', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  f.state.appId = '00000000-0000-4000-8000-000000000000';
  const res = await f.publish({ stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(res.error, true);
  assert.ok(res.data.failures.some(x => x.startsWith('appId:')));
  assert.equal(f.publishCalls.length, 0);
});

test('Environment ID不一致は公開直前に拒否する', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  f.state.environmentId = '11111111-1111-4111-8111-111111111111';
  const res = await f.publish({ stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(res.error, true);
  assert.ok(res.data.failures.some(x => x.startsWith('environmentId:')));
  assert.equal(f.publishCalls.length, 0);
});

test('非canonical branchは拒否する（branch指定・状態の両方）', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  const byParam = await f.publish({ branch: 'fallback', stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(byParam.error, true);
  assert.equal(byParam.data.status, 'branch_mismatch');
  assert.equal(f.publishCalls.length, 0);

  const g = await fixture(t);
  g.git.branch = 'fallback';
  const a = await g.rpc('get_powerapps_state');
  const b = await g.rpc('get_powerapps_source', { relativePath: PATH, correlationId: a.data.correlationId, stateSessionId: a.data.stateSessionId });
  const byState = await g.publish({ stateContext: b.data.stateContext, stateSessionId: b.data.stateSessionId });
  assert.equal(byState.error, true);
  assert.equal(g.publishCalls.length, 0);
});

test('DEPLOYMENT_SHA不一致（稼働中SHAが正本commitと違う）は拒否する', async (t) => {
  const f = await fixture(t, { deploymentSha: OTHER_COMMIT });
  const session = await f.observedSession();
  const res = await f.publish({ stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(res.error, true);
  assert.ok(res.data.failures.some(x => x.startsWith('deploymentSha:')));
  assert.equal(f.publishCalls.length, 0);
});

test('DEPLOYMENT_SHA未設定は拒否する', async (t) => {
  const f = await fixture(t, { deploymentSha: null });
  const session = await f.observedSession();
  const res = await f.publish({ stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(res.error, true);
  assert.equal(f.publishCalls.length, 0);
});

test('状態条件一致だけでは独立承認ゲート未設定の公開を拒否する', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  const res = await f.publish({ stateContext: session.stateContext, stateSessionId: session.stateSessionId });
  assert.equal(res.error, true);
  assert.equal(f.publishCalls.length, 0, '承認未設定では公開APIに到達しない');
});

test('validate系3経路: commit/blobを分離して正しく通し、blob変更は拒否する', async (t) => {
  const f = await fixture(t);
  const session = await f.observedSession();
  const base = { relativePath: 'powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml', stateContext: session.stateContext, stateSessionId: session.stateSessionId, sourceContent: CONTENT, expectedBranch: 'main' };
  const ok = await f.rpc('validate_powerapps_source', base);
  assert.equal(ok.error, false, 'commit SHA一致・blob一致は通過する');

  f.git.blob = OTHER_BLOB;
  const changed = await f.rpc('validate_powerapps_source', base);
  assert.equal(changed.error, true, 'blob変更は拒否する');
});
