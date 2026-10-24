const test = require('node:test');
const assert = require('node:assert/strict');
const { MCP_PUBLIC_TOOLS } = require('../src/server');
const { validateRunPowerAppsTestsParams } = require('../src/powerAppsValidation');
const { validateStateContext, FAIL_CLOSED_TOOLS } = require('../src/stateManager');

const stateContext = {
  appId: 'app-123', environment: 'env-123', branch: 'main',
  canonicalBranch: 'main', sha: 'a'.repeat(40),
  correlationId: '00000000-0000-4000-8000-000000000001'
};
const files = [{ relativePath: 'S1_Home.pa.yaml', content: 'Screens: {}' }];

test('static tests expose session and context in MCP contract', () => {
  const schema = MCP_PUBLIC_TOOLS.find(t => t.name === 'run_powerapps_tests').inputSchema;
  assert.ok(schema.properties.stateContext);
  assert.ok(schema.properties.stateSessionId);
  assert.equal(schema.additionalProperties, false);
});

test('static tests validator accepts complete context without relaxing file checks', () => {
  assert.equal(validateRunPowerAppsTestsParams({ files, stateContext, stateSessionId: 'session-123' }), null);
  assert.match(validateRunPowerAppsTestsParams({ files: [{ relativePath: 'a' }], stateContext, stateSessionId: 'session-123' }), /content/);
  assert.match(validateRunPowerAppsTestsParams({ files, unexpected: true }), /未対応/);
});

test('Fail-Closed preflight still rejects missing and mismatched context', () => {
  assert.ok(FAIL_CLOSED_TOOLS.includes('run_powerapps_tests'));
  assert.equal(validateStateContext('run_powerapps_tests', { files }, null).isValid, false);
  assert.equal(validateStateContext('run_powerapps_tests', { files }, stateContext).isValid, true);
  assert.equal(validateStateContext('run_powerapps_tests', { files }, { ...stateContext, branch: 'feature' }).isValid, false);
});
