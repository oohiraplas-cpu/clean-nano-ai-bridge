'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');
const { collect } = require('../scripts/check-azure-metadata-only');
const { createAzureMetadataReader } = require('../src/azureMetadataReader');

const CANARY = 'secret-canary-must-not-escape';
const app = { name: 'clean-nano-ai-bridge', resourceGroup: 'rg-test',
  id: '/subscriptions/sub-test/resourceGroups/rg-test/providers/Microsoft.Web/sites/clean-nano-ai-bridge' };
const identity = { type: 'SystemAssigned', principalId: '11111111-1111-4111-8111-111111111111' };
function processError(properties) {
  return Object.assign(new Error(CANARY), { stderr: CANARY, stdout: CANARY }, properties);
}
function fakeCli(overrides = {}) {
  const calls = [];
  const runCli = (command, args, options) => {
    calls.push(args);
    assert.equal(command, 'az');
    assert.equal(options.timeout, 20000);
    const key = args[1] === 'list' ? 'target' : args[1] === 'identity' ? 'identity' : 'deployments';
    const value = Object.hasOwn(overrides, key) ? overrides[key]
      : { target: [app], identity, deployments: [] }[key];
    if (value instanceof Error) throw value;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  return { runCli, calls };
}
const envelopes = [
  { name: 'legacy', body: { method: 'get_azure_deployment_metadata', params: {} }, read: body => body.result },
  { name: 'tools/call', body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_azure_deployment_metadata', arguments: {} } }, read: body => body.result.structuredContent },
  { name: 'direct JSON-RPC', body: { jsonrpc: '2.0', id: 2, method: 'get_azure_deployment_metadata', params: {} }, read: body => body.result }
];
async function throughMcp(t, reader, verify) {
  const config = getConfig({ MCP_API_KEY: 'test-key' });
  const bridge = createApp(config, { list: async () => [] }, undefined, undefined,
    undefined, undefined, undefined, { azureMetadata: reader });
  const server = await new Promise(resolve => {
    const instance = bridge.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const envelope of envelopes) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify(envelope.body)
    });
    assert.equal(response.status, 200, envelope.name);
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes(CANARY), false, envelope.name);
    const result = envelope.read(body);
    assert.ok(result, envelope.name);
    assert.notEqual(result.deploymentShaMatched, true);
    assert.notEqual(result.effectiveRbacVerified, true);
    assert.notEqual(result.pacRuntimeVerified, true);
    assert.notEqual(result.diagnostic?.status, 'confirmed');
    verify(result, envelope.name);
  }
}

const cases = [
  ['missing CLI', { target: processError({ code: 'ENOENT' }) }, 'target_lookup', 'cli_missing', false],
  ['CLI timeout', { target: processError({ code: 'ETIMEDOUT' }) }, 'target_lookup', 'timeout', false],
  ['CLI nonzero exit', { target: processError({ status: 1 }) }, 'target_lookup', 'cli_exit_nonzero', false],
  ['unknown CLI failure', { target: processError({}) }, 'target_lookup', 'cli_execution_failed', false],
  ['malformed JSON', { target: CANARY }, 'target_lookup', 'malformed_json', false],
  ['invalid target response', { target: {} }, 'target_lookup', 'invalid_response', false],
  ['no target', { target: [] }, 'target_lookup', 'target_not_unique', false],
  ['ambiguous target', { target: [app, app] }, 'target_lookup', 'target_not_unique', false],
  ['wrong resource', { target: [{ ...app, id: app.id.replace('sites/clean-nano-ai-bridge', 'sites/other') }] }, 'target_lookup', 'resource_id_mismatch', false],
  ['identity failure', { identity: processError({ status: 1 }) }, 'identity_lookup', 'cli_exit_nonzero', true],
  ['identity absent', { identity: {} }, 'identity_lookup', 'identity_unverified', true],
  ['deployment failure', { deployments: processError({ code: 'ETIMEDOUT' }) }, 'deployment_history', 'timeout', true],
  ['invalid deployment response', { deployments: [null] }, 'deployment_history', 'invalid_response', true]
];
for (const [name, overrides, stage, reason, matched] of cases) {
  test(`Azure diagnostics survive all MCP envelopes: ${name}`, async t => {
    const fake = fakeCli(overrides);
    const reader = createAzureMetadataReader({ collectMetadata: () => collect({ runCli: fake.runCli }) });
    await throughMcp(t, reader, result => {
      assert.equal(result.resourceIdMatched, matched);
      assert.deepEqual(result.metadataFailures, [{ stage, reason }]);
      // Identity observations do not determine whether deployment metadata was fetched.
      assert.equal(result.status, stage === 'identity_lookup' ? 'observed_not_verified' : 'blocked');
    });
    assert.ok(fake.calls.every(args => args[0] === 'webapp'));
  });
}

test('empty deployment history is observed but cannot establish deployment readiness', async t => {
  const fake = fakeCli();
  await throughMcp(t, createAzureMetadataReader({ collectMetadata: () => collect({ runCli: fake.runCli }) }), result => {
    assert.equal(result.status, 'observed_not_verified');
    assert.deepEqual(result.deploymentEntries, []);
    assert.deepEqual(result.metadataFailures, []);
    assert.equal(result.deploymentShaMatched, false);
    assert.equal(result.effectiveRbacVerified, false);
    assert.equal(result.pacRuntimeVerified, false);
    assert.equal(result.diagnostic.status, 'blocked');
  });
});

test('forged diagnostic claims and unknown enum values cannot escape through MCP', async t => {
  await throughMcp(t, { readDeploymentMetadata: async () => ({
    resourceIdMatched: true, deploymentEntries: [], deploymentShaMatched: true,
    effectiveRbacVerified: true, pacRuntimeVerified: true,
    diagnostic: { status: 'confirmed', secret: CANARY }, secret: CANARY,
    metadataFailures: [
      { stage: CANARY, reason: 'timeout' },
      { stage: 'target_lookup', reason: CANARY },
      { stage: 'deployment_history', reason: 'cli_exit_nonzero', secret: CANARY }
    ]
  }) }, result => {
    assert.equal(result.status, 'observed_not_verified');
    assert.equal(result.diagnostic.status, 'blocked');
    assert.deepEqual(result.metadataFailures, [{ stage: 'deployment_history', reason: 'cli_exit_nonzero' }]);
    assert.equal(result.deploymentShaMatched, false);
    assert.equal(result.effectiveRbacVerified, false);
    assert.equal(result.pacRuntimeVerified, false);
  });
});

test('throwing reader produces a fixed safe failure in all MCP envelopes', async t => {
  await throughMcp(t, { readDeploymentMetadata: async () => { throw processError({}); } }, result => {
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'azure_metadata_unavailable');
    assert.deepEqual(result.metadataFailures, [{ stage: 'metadata_reader', reason: 'reader_failed' }]);
  });
});
