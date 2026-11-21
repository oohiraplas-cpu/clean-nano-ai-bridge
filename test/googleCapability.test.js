'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const g = require('../src/googleCapability');
const cnaiRouter = require('../src/cnaiRouter');

const SID = 'script_id_1234567890';
const SHEET = 'sheet_id_1234567890';
const MANIFEST = { name: 'appsscript', type: 'JSON', source: '{"timeZone":"Asia/Tokyo"}' };

function fakeClient(over = {}) {
  const state = { files: [MANIFEST, { name: 'Code', type: 'SERVER_JS', source: 'function a(){}' }], grid: [['a', 'b']], deployments: [], calls: [] };
  const rec = (name, fn) => async (...args) => { state.calls.push(name); return fn(...args); };
  const client = {
    sheetsGet: rec('sheetsGet', async (_s, range) => ({ range, values: state.grid })),
    sheetsUpdate: rec('sheetsUpdate', async (_s, _r, values) => { state.grid = values; }),
    driveMeta: rec('driveMeta', async (fid) => ({ id: fid, name: 'x' })),
    driveList: rec('driveList', async () => ({ files: [] })),
    gasGetContent: rec('gasGetContent', async () => ({ files: state.files })),
    gasUpdateContent: rec('gasUpdateContent', async (_s, files) => { state.files = files; }),
    gasCreateVersion: rec('gasCreateVersion', async () => ({ versionNumber: 3 })),
    gasDeploy: rec('gasDeploy', async () => { const d = { deploymentId: 'dep1' }; state.deployments.push(d); return d; }),
    gasListDeployments: rec('gasListDeployments', async () => ({ deployments: state.deployments })),
    gasRun: rec('gasRun', async () => ({ done: true, response: { result: 'ok' } })),
    ...over
  };
  return { client, state };
}
const run = (deps, capability, params, approvedByHuman) => g.executeGoogleCapability({ config: {}, ...deps }, { capability, params, approvedByHuman });
const newFiles = [MANIFEST, { name: 'Code', type: 'SERVER_JS', source: 'function b(){}' }];

test('registry: GAS capabilities and Gemini owner, AppSheet not required', () => {
  const d = g.describeCapabilities({ providers: { gemini: { status: 'BLOCKED' } } });
  for (const c of ['gas.read', 'gas.update', 'gas.deploy', 'gas.execute', 'gas.verify']) assert.ok(d.capabilities.some((x) => x.capability === c), c);
  assert.equal(d.implementationOwner, 'gemini');
  assert.equal(d.ownerStatus, 'BLOCKED');
  assert.equal(d.appSheetApiRequired, false);
});

test('READ runs automatically without approval (gas.read / sheets.read / drive.read / cnkk.read)', async () => {
  const { client } = fakeClient();
  const r = await run({ client }, 'gas.read', { scriptId: SID });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
  assert.equal(r.files.some((f) => 'source' in f), false);
  assert.equal((await run({ client }, 'sheets.read', { spreadsheetId: SHEET, range: 'A1:B1' })).verified, true);
  assert.equal((await run({ client }, 'drive.read', { fileId: SHEET })).success, true);
  const c = await g.executeGoogleCapability({ client, config: { cnkk: { spreadsheetId: SHEET } } }, { capability: 'cnkk.read', params: { range: 'A1:B1' } });
  assert.equal(c.success, true);
});

test('gas.update / gas.deploy are blocked without human approval and make no API call', async () => {
  for (const [cap, params] of [['gas.update', { scriptId: SID, files: newFiles }], ['gas.deploy', { scriptId: SID }]]) {
    const { client, state } = fakeClient();
    const r = await run({ client }, cap, params);
    assert.equal(r.errorCode, 'HUMAN_APPROVAL_REQUIRED');
    assert.equal(state.calls.length, 0);
    assert.equal(r.evidence.humanGate.required, true);
  }
});

test('gas.update approved: snapshot -> write -> re-fetch -> VERIFIED with evidence', async () => {
  const snapshots = new Map();
  const { client, state } = fakeClient();
  const r = await run({ client, snapshots }, 'gas.update', { scriptId: SID, files: newFiles }, true);
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
  assert.ok(snapshots.get(r.snapshotId).files.some((f) => f.source === 'function a(){}'));
  assert.deepEqual(state.calls, ['gasGetContent', 'gasUpdateContent', 'gasGetContent']);
  assert.notEqual(r.evidence.before.manifestHash, r.evidence.after.manifestHash);
  assert.equal(r.evidence.humanGate.approved, true);
});

test('gas.update: readback mismatch is not reported as success', async () => {
  const { client } = fakeClient({ gasUpdateContent: async () => {} });
  const r = await run({ client }, 'gas.update', { scriptId: SID, files: newFiles }, true);
  assert.equal(r.success, false);
  assert.equal(r.errorCode, 'VERIFICATION_FAILED');
});

test('gas.update rejects files without appsscript manifest', async () => {
  const { client, state } = fakeClient();
  const r = await run({ client }, 'gas.update', { scriptId: SID, files: [newFiles[1]] }, true);
  assert.equal(r.errorCode, 'INVALID_INPUT');
  assert.equal(state.calls.includes('gasUpdateContent'), false);
});

test('gas.deploy approved: creates version+deployment and re-lists', async () => {
  const { client } = fakeClient();
  const r = await run({ client }, 'gas.deploy', { scriptId: SID, description: 'v' }, true);
  assert.equal(r.verified, true);
  assert.equal(r.deploymentId, 'dep1');
  assert.equal(r.evidence.after.versionNumber, 3);
});

test('gas.execute: gated unless function is allowlisted; result is never VERIFIED by itself', async () => {
  const { client, state } = fakeClient();
  const blocked = await run({ client }, 'gas.execute', { scriptId: SID, function: 'doWork' });
  assert.equal(blocked.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(state.calls.length, 0);
  const allowed = await g.executeGoogleCapability({ client, config: { readonlyFunctions: ['getStatus'] } }, { capability: 'gas.execute', params: { scriptId: SID, function: 'getStatus' } });
  assert.equal(allowed.success, true);
  assert.equal(allowed.verified, false);
});

test('gas.verify: compares against expectation; no expectation -> not PASS', async () => {
  const { client } = fakeClient();
  const read = await run({ client }, 'gas.read', { scriptId: SID });
  const ok = await run({ client }, 'gas.verify', { scriptId: SID, expectedManifestHash: read.manifestHash });
  assert.equal(ok.verified, true);
  const bad = await run({ client }, 'gas.verify', { scriptId: SID, expectedManifestHash: 'x' });
  assert.equal(bad.errorCode, 'VERIFICATION_FAILED');
  const none = await run({ client }, 'gas.verify', { scriptId: SID });
  assert.equal(none.verified, false);
  assert.equal(none.errorCode, 'NO_EXPECTATION');
});

test('sheets.update / cnkk.update: snapshot + readback verified (no human gate by default)', async () => {
  const { client } = fakeClient();
  const r = await g.executeGoogleCapability({ client, config: { cnkk: { spreadsheetId: SHEET } } }, { capability: 'cnkk.update', params: { range: 'A1:B1', values: [['x', 'y']] } });
  assert.equal(r.verified, true);
  assert.ok(r.snapshotId);
  const unconfigured = await run({ client }, 'cnkk.update', { range: 'A1', values: [['x']] });
  assert.equal(unconfigured.errorCode, 'ADAPTER_NOT_CONFIGURED');
});

test('no client / unknown capability fail closed; secrets are masked from errors and output', async () => {
  assert.equal((await run({}, 'gas.read', { scriptId: SID })).errorCode, 'ADAPTER_NOT_CONFIGURED');
  assert.equal((await run({ client: {} }, 'gas.nope', {})).errorCode, 'UNKNOWN_CAPABILITY');
  const { client } = fakeClient({ gasGetContent: async () => { throw new g.GoogleCapabilityError('boom Bearer abcdefghijklmnop1234', 'UPSTREAM_ERROR'); } });
  const r = await run({ client }, 'gas.read', { scriptId: SID });
  assert.equal(JSON.stringify(r).includes('abcdefghijklmnop1234'), false);
});

test('OAuth client: refresh-token exchange, token not exposed in failures', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tok_SECRET_123456', expires_in: 3600 }) };
    assert.equal(init.headers.authorization, 'Bearer tok_SECRET_123456');
    return { ok: true, text: async () => JSON.stringify({ files: [] }) };
  };
  const client = g.createGoogleClient({ oauth: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' }, fetchImpl });
  await client.gasGetContent(SID);
  await client.gasGetContent(SID);
  assert.equal(calls.filter((u) => u.includes('oauth2')).length, 1);
  const bad = g.createGoogleClient({ oauth: {}, fetchImpl });
  await assert.rejects(() => bad.gasGetContent(SID), /未構成/);
});

test('Router: gas/sheets/cnkk hints route to googleWorkspace; unconfigured -> BLOCKED; configured -> executed', async () => {
  for (const hint of ['gas', 'sheets', 'drive', 'cnkk', 'google', 'appsscript']) {
    assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: hint }).route, 'googleWorkspace');
  }
  const blocked = await cnaiRouter.routeRequest(cnaiRouter.createRouterState(), { requestType: 'gas.read', platformHint: 'gas', payload: { params: { scriptId: SID } } });
  assert.equal(blocked.executionStatus, 'BLOCKED');
  assert.equal(blocked.errorCode, 'ADAPTER_NOT_CONFIGURED');

  const { client } = fakeClient();
  const adapters = cnaiRouter.defaultAdapters({ adapters: { googleWorkspace: g.createGoogleWorkspaceAdapter({ client, config: {} }) } });
  const state = cnaiRouter.createRouterState();
  const read = await cnaiRouter.routeRequest(state, { requestType: 'gas.read', platformHint: 'gas', payload: { params: { scriptId: SID } } }, adapters);
  assert.equal(read.executionStatus, 'COMPLETED');
  const upd = { requestType: 'gas.update', platformHint: 'gas', payload: { params: { scriptId: SID, files: newFiles } } };
  const gated = await cnaiRouter.routeRequest(state, upd, adapters);
  assert.equal(gated.executionStatus, 'BLOCKED');
  assert.equal(gated.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  const done = await cnaiRouter.resumeRequest(state, gated.requestId, { ...upd, approvedByHuman: true }, adapters);
  assert.equal(done.executionStatus, 'COMPLETED');
  assert.equal(done.lastDispatchOutput.evidence.after.fileCount, 2);
});
