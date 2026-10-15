// A3: characterization tests for the production write gate (StateContextRegistry.validate).
// These pin the existing fail-closed conditions; they do not change production behaviour.
// Mapping to the V2 execution-contract rules (canWrite):
//   state ready        -> context registered and source bound (validate)
//   branch == canonical -> "branch: non-canonical source"
//   actualSha == expected -> "sha: mismatch with registered commit" / sourceContent hash
const assert = require('node:assert/strict');
const test = require('node:test');
const { StateContextRegistry, blobSha } = require('../src/stateContext');

const APP = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
const ENV = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const PATH = 'powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml';
const CONTENT = 'Screens:\n  S1_Home:\n    Properties:\n      Fill: =Color.White\n';
const SCOPE = 'scope';

function bound(registry, { branch = 'main', canonicalBranch = 'main' } = {}) {
  const reg = registry.begin({ appId: APP, environmentId: ENV }, SCOPE);
  const source = { path: PATH, content: CONTENT, sha: blobSha(CONTENT), branch, canonicalBranch };
  const response = registry.bind(reg.correlationId, reg.stateSessionId, SCOPE, source, PATH);
  return { context: { ...response.stateContext }, stateSessionId: reg.stateSessionId };
}

test('write gate: canonical, bound context passes validate()', () => {
  const registry = new StateContextRegistry();
  const { context, stateSessionId } = bound(registry);
  const record = registry.validate(context, stateSessionId, SCOPE, { relativePath: PATH, sourceContent: CONTENT }, 'save_powerapps_app');
  assert.equal(record.context.correlationId, context.correlationId);
});

test('write gate: non-canonical branch is rejected', () => {
  const registry = new StateContextRegistry();
  const { context, stateSessionId } = bound(registry, { branch: 'fallback', canonicalBranch: 'main' });
  assert.throws(() => registry.validate(context, stateSessionId, SCOPE, {}, 'save_powerapps_app'), /non-canonical source/);
});

test('write gate: commit sha mismatch is rejected', () => {
  const registry = new StateContextRegistry();
  const { context, stateSessionId } = bound(registry);
  assert.throws(() => registry.validate({ ...context, sha: '1'.repeat(40) }, stateSessionId, SCOPE, {}, 'save_powerapps_app'), /sha: mismatch/);
});

test('write gate: malformed sha is rejected before lookup', () => {
  const registry = new StateContextRegistry();
  const { context, stateSessionId } = bound(registry);
  assert.throws(() => registry.validate({ ...context, sha: 'not-a-sha' }, stateSessionId, SCOPE, {}, 'save_powerapps_app'), /40-character/);
});

test('write gate: unexpected top-level field is rejected', () => {
  const registry = new StateContextRegistry();
  const { context, stateSessionId } = bound(registry);
  assert.throws(() => registry.validate({ ...context, extra: 'x' }, stateSessionId, SCOPE, {}, 'save_powerapps_app'), /unexpected field/);
});

test('write gate: wrong stateSessionId is rejected', () => {
  const registry = new StateContextRegistry();
  const { context } = bound(registry);
  assert.throws(() => registry.validate(context, '00000000-0000-4000-8000-000000000000', SCOPE, {}, 'save_powerapps_app'), /session mismatch/);
});

test('write gate: wrong scope is rejected', () => {
  const registry = new StateContextRegistry();
  const { context, stateSessionId } = bound(registry);
  assert.throws(() => registry.validate(context, stateSessionId, 'other-scope', {}, 'save_powerapps_app'), /session mismatch/);
});

test('write gate: expired registration is rejected', () => {
  let now = 1_000_000;
  const registry = new StateContextRegistry({ ttlMs: 1000, now: () => now });
  const { context, stateSessionId } = bound(registry);
  now += 1001;
  assert.throws(() => registry.validate(context, stateSessionId, SCOPE, {}, 'save_powerapps_app'), /expired|not registered/);
});

test('write gate: context without an acquired source is rejected', () => {
  const registry = new StateContextRegistry();
  const reg = registry.begin({ appId: APP, environmentId: ENV }, SCOPE);
  const context = { appId: APP, environment: ENV, branch: 'main', canonicalBranch: 'main', sha: 'a'.repeat(40), correlationId: reg.correlationId };
  assert.throws(() => registry.validate(context, reg.stateSessionId, SCOPE, {}, 'save_powerapps_app'), /source not acquired/);
});

test('write gate: source content drift is rejected', () => {
  const registry = new StateContextRegistry();
  const { context, stateSessionId } = bound(registry);
  assert.throws(() => registry.validate(context, stateSessionId, SCOPE, { sourceContent: CONTENT + '#changed' }, 'save_powerapps_app'), /sourceContent: mismatch/);
});

test('write gate: invalidated session cannot be used for writes', () => {
  const registry = new StateContextRegistry();
  const { context, stateSessionId } = bound(registry);
  assert.equal(registry.invalidateBySessionId(stateSessionId).invalidated, true);
  assert.throws(() => registry.validate(context, stateSessionId, SCOPE, {}, 'save_powerapps_app'), /not registered/);
});
