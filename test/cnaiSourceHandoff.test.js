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
