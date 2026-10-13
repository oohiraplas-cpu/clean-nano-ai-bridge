'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');
const { validateUpdatePowerAppsAppParams } = require('../src/powerAppsValidation');
const content = 'Screens:\n  S1_Home: {}\n';
const blob = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
function fixture(overrides = {}) {
  const store = new PowerAppsGitStore({ githubOwner: 'owner', githubRepo: 'repo' });
  let syncs = 0;
  store.updateSourceFile = async () => ({ branch: 'main', path: 'powerapps/app/Source/S1_Home.pa.yaml', commitSha: 'a'.repeat(40), contentSha: blob, ...overrides });
  store.refreshFromGit = store.pullFromGit = async () => { syncs++; throw new Error('must not sync'); };
  return { store, syncs: () => syncs };
}
test('CNAI receipt binds the edited content and requires separate save/publication verification', async () => {
  const f = fixture();
  const r = await f.store.applySourceFileChange('S1_Home.pa.yaml', content, 'edit', 'main', true);
  assert.equal(r.status, 'handoff_prepared');
  assert.equal(r.handoff.contentSha, blob);
  assert.equal(r.handoff.contentSha256, crypto.createHash('sha256').update(content).digest('hex'));
  assert.equal(r.handoff.readbackRequired, true);
  assert.equal(r.handoff.humanApprovalRequired, true);
  assert.equal(r.handoff.readyForSave, false);
  assert.equal(r.handoff.readyForPublish, false);
  assert.equal(r.saved, false); assert.equal(r.published, false);
  assert.equal(f.syncs(), 0);
});
test('unproven Git commit or content never yields a usable CNAI handoff', async () => {
  for (const override of [{ commitSha: null }, { contentSha: 'b'.repeat(40) }]) {
    const f = fixture(override);
    const r = await f.store.applySourceFileChange('S1_Home.pa.yaml', content, 'edit', 'main', true);
    assert.equal(r.status, 'blocked'); assert.equal(r.handoff, undefined);
    assert.equal(r.retryAllowed, false); assert.equal(f.syncs(), 0);
  }
});
test('deferSync rejects non-booleans and metadata-edit misuse', () => {
  const input = { relativePath: 'S1_Home.pa.yaml', content, branch: 'main' };
  assert.equal(validateUpdatePowerAppsAppParams({ ...input, deferSync: true }), null);
  for (const deferSync of ['true', 'false', 1, null]) {
    assert.ok(validateUpdatePowerAppsAppParams({ ...input, deferSync }));
  }
  assert.ok(validateUpdatePowerAppsAppParams({ updateData: { description: 'x' }, deferSync: true }));
});

function receiverFixture() {
  const h = { recipient: 'CNAI', repository: 'owner/repo', branch: 'main',
    path: 'powerapps/app/Source/S1_Home.pa.yaml', commitSha: 'a'.repeat(40), contentSha: blob,
    contentSha256: crypto.createHash('sha256').update(content).digest('hex'),
    target: { appId: 'app', environmentId: 'env' }, readyForSave: true, readyForPublish: true };
  const calls = [];
  let head = h.commitSha;
  const store = new PowerAppsGitStore({ githubOwner: 'owner', githubRepo: 'repo', githubRoot: 'powerapps/app/Source' });
  store._githubRequest = async (path, options) => {
    calls.push({ path, options });
    if (path.includes('/git/refs/heads/')) return { object: { sha: head } };
    return { type: 'file', encoding: 'base64', path: h.path, sha: blob, content: Buffer.from(content).toString('base64') };
  };
  const app = { appId: 'app', environmentId: 'env', getAppState: async () => ({ status: 'ok', appId: 'app', environmentId: 'env' }) };
  return { h, store, app, calls, changeHead: () => { head = 'c'.repeat(40); } };
}
test('receiver verifies immutable source and live target but never grants save or publish', async () => {
  const f = receiverFixture();
  const r = await f.store.verifySourceHandoff(f.h, f.app);
  assert.equal(r.status, 'handoff_verified'); assert.equal(r.sourceVerified, true);
  assert.equal(r.readyForSave, false); assert.equal(r.readyForPublish, false);
  assert.equal(r.saved, false); assert.equal(r.published, false);
  assert.ok(r.blockers.includes('bound_single_use_save_approval_required'));
  assert.ok(f.calls.some(c => c.path.endsWith('?ref=' + f.h.commitSha)));
  assert.ok(f.calls.every(c => c.options === undefined));
});
test('wrong repository, branch, target and unsafe path fail before external reads', async () => {
  for (const patch of [{ repository: 'other/repo' }, { branch: 'other' }, { target: { appId: 'other', environmentId: 'env' } },
    { path: 'powerapps/app/Source/../Secret.pa.yaml' }, { path: 'powerapps/app/Source/%2e%2e/Secret.pa.yaml' },
    { path: 'powerapps/app/Other.pa.yaml' }, { commitSha: 'main' }]) {
    const f = receiverFixture();
    const r = await f.store.verifySourceHandoff({ ...f.h, ...patch }, f.app);
    assert.equal(r.sourceVerified, false); assert.equal(f.calls.length, 0);
  }
});
test('forged blob/content hashes and stale HEAD are rejected', async () => {
  for (const patch of [{ contentSha: 'b'.repeat(40) }, { contentSha256: 'b'.repeat(64) }]) {
    const f = receiverFixture();
    assert.equal((await f.store.verifySourceHandoff({ ...f.h, ...patch }, f.app)).sourceVerified, false);
  }
  const f = receiverFixture(); f.changeHead();
  assert.equal((await f.store.verifySourceHandoff(f.h, f.app)).reason, 'handoff_stale_head');
});
test('receiver detects a HEAD change during immutable file retrieval', async () => {
  const f = receiverFixture(), read = f.store._githubRequest;
  f.store._githubRequest = async (...args) => { const result = await read(...args); if (args[0].includes('/contents/')) f.changeHead(); return result; };
  assert.equal((await f.store.verifySourceHandoff(f.h, f.app)).reason, 'handoff_stale_head');
});
test('live target mismatch and read failure never yield verified handoff', async () => {
  const f = receiverFixture(); f.app.getAppState = async () => ({ status: 'ok', appId: 'other', environmentId: 'env' });
  assert.equal((await f.store.verifySourceHandoff(f.h, f.app)).reason, 'handoff_live_target_mismatch');
  const g = receiverFixture(); g.store._githubRequest = async () => { throw Error('contains-sensitive-upstream-data'); };
  const r = await g.store.verifySourceHandoff(g.h, g.app);
  assert.equal(r.reason, 'handoff_verification_unavailable');
  assert.equal(JSON.stringify(r).includes('sensitive'), false);
});
test('handoff mode cannot fall through to mutating orchestration, even with publishing text', async () => {
  const { PowerPlatformRequestHandler, validateExecutePowerPlatformRequestParams } = require('../src/powerPlatformRequestHandler');
  const f = receiverFixture();
  const handler = new PowerPlatformRequestHandler({ powerAppsGitStore: f.store, powerAppsStore: f.app, config: {} });
  let mutations = 0;
  handler.orchestrator.executePowerPlatformRequest = async () => { mutations++; throw Error('must not execute'); };
  const result = await handler.executePowerPlatformRequest({ request: 'save and publish', sourceHandoff: f.h });
  assert.equal(result.conclusion, 'HANDOFF_VERIFIED'); assert.equal(mutations, 0);
  assert.equal((await handler.executePowerPlatformRequest({ request: 'publish', sourceHandoff: f.h, publishApproval: true })).conclusion, 'BLOCKED');
  assert.ok(validateExecutePowerPlatformRequestParams({ request: 'verify', sourceHandoff: f.h, targetId: 'other' }));
  assert.equal(mutations, 0);
});
