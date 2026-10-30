'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { StateContextRegistry } = require('../src/stateContext');

function blobSha(content) {
  return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
}

test('registered canonical state and observed source permit validated static-test context', () => {
  const registry = new StateContextRegistry();
  const scope = 'authorized-scope';
  const sourceText = 'Screens:\n  S1_Home:\n';
  const observed = registry.begin({
    appId: 'test-app',
    environmentId: 'test-environment',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40)
  }, scope);
  const path = 'powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml';
  registry.bindSourceObservation(
    observed.stateContext.correlationId,
    observed.stateSessionId,
    scope,
    { path, content: sourceText, sha: blobSha(sourceText) },
    'S1_Home.pa.yaml'
  );
  const args = {
    files: [{ relativePath: 'S1_Home.pa.yaml', content: sourceText }],
    stateContext: observed.stateContext,
    stateSessionId: observed.stateSessionId
  };
  const record = registry.validate(args.stateContext, args.stateSessionId, scope, args, 'run_powerapps_tests');
  assert.equal(record.context.appId, 'test-app');
  assert.equal(record.source.sha, blobSha(sourceText));
  assert.equal(registry.validate(args.stateContext, args.stateSessionId, scope, args, 'run_powerapps_tests'), record);
  assert.throws(() => registry.validate(args.stateContext, args.stateSessionId, 'different-scope', args, 'run_powerapps_tests'));
  assert.throws(() => registry.validate({ ...args.stateContext, sha: 'b'.repeat(40) }, args.stateSessionId, scope, args, 'run_powerapps_tests'));
});

test('source observation is mandatory before registry permits static-test context', () => {
  const registry = new StateContextRegistry();
  const scope = 'authorized-scope';
  const observed = registry.begin({
    appId: 'test-app',
    environmentId: 'test-environment',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'a'.repeat(40)
  }, scope);
  assert.throws(() => registry.validate(observed.stateContext, observed.stateSessionId, scope, { files: [] }, 'run_powerapps_tests'), /source not acquired/);
});
