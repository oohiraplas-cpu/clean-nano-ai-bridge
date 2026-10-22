'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StateContextRegistry, blobSha } = require('../src/stateContext');

function fixture() {
  const registry = new StateContextRegistry();
  const scope = 'authenticated-request-scope';
  const session = registry.begin({
    appId: 'app-test', environmentId: 'environment-test', branch: 'main',
    canonicalBranch: 'main', sha: 'a'.repeat(40),
  }, scope);
  const content = 'Screens:\\n  S8_UserOnboarding: {}\\n';
  const source = { path: 'powerapps/CN_AI依頼台帳/Source/S8_UserOnboarding.pa.yaml', content, sha: blobSha(content) };
  return { registry, scope, session, source };
}

test('state -> source observation: same authenticated scope binds valid Git blob', () => {
  const { registry, scope, session, source } = fixture();
  const result = registry.bindSourceObservation(session.correlationId, session.stateSessionId, scope, source, source.path);
  assert.equal(result.sourceObservationComplete, true);
  assert.equal(result.stateContextComplete, true);
});

test('state -> source observation: different scope fails closed', () => {
  const { registry, session, source } = fixture();
  assert.throws(() => registry.bindSourceObservation(session.correlationId, session.stateSessionId, 'POWERAPPS_SOURCE_RESOLUTION', source, source.path), /stateSessionId: missing or session mismatch/);
  assert.equal(registry.response(registry.lookup(session.correlationId, session.stateSessionId, 'authenticated-request-scope')).sourceObservationComplete, false);
});

test('state -> source observation: altered session fails closed', () => {
  const { registry, scope, session, source } = fixture();
  assert.throws(() => registry.bindSourceObservation(session.correlationId, '00000000-0000-4000-8000-000000000000', scope, source, source.path), /stateSessionId: missing or session mismatch/);
});

test('state -> source observation: invalid source hash fails closed', () => {
  const { registry, scope, session, source } = fixture();
  assert.throws(() => registry.bindSourceObservation(session.correlationId, session.stateSessionId, scope, {...source, sha: '0'.repeat(40)}, source.path), /sha: observed content does not match blob SHA/);
});
