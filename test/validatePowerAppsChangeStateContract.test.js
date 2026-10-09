const test = require('node:test');
const assert = require('node:assert/strict');

const { validateValidatePowerAppsChangeParams } = require('../src/powerAppsValidation');
const { MCP_PUBLIC_TOOLS } = require('../src/server');
const { REQUIRED_STATE_FIELDS } = require('../src/stateContext');

const validContext = {
  appId: 'app-123',
  environment: 'env-123',
  branch: 'main',
  canonicalBranch: 'main',
  sha: 'a'.repeat(40),
  correlationId: '12345678-1234-4123-8123-123456789012'
};

function validParams() {
  return {
    branch: 'main',
    relativePath: 'powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml',
    content: 'Screen: S1_Home\n',
    stateContext: { ...validContext },
    stateSessionId: '12345678-1234-4123-8123-123456789013'
  };
}

test('validate_powerapps_change publishes and accepts the complete registered context contract', () => {
  const tool = MCP_PUBLIC_TOOLS.find(item => item.name === 'validate_powerapps_change');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['branch', 'relativePath', 'stateContext', 'stateSessionId']);
  assert.deepEqual(tool.inputSchema.properties.stateContext.required, REQUIRED_STATE_FIELDS);
  assert.equal(validateValidatePowerAppsChangeParams(validParams()), null);
});

test('validate_powerapps_change rejects missing context/session, extra fields and invalid SHA', () => {
  const missingContext = validParams();
  delete missingContext.stateContext;
  assert.match(validateValidatePowerAppsChangeParams(missingContext), /stateContext/);

  const missingSession = validParams();
  delete missingSession.stateSessionId;
  assert.match(validateValidatePowerAppsChangeParams(missingSession), /stateSessionId/);

  const extra = validParams();
  extra.stateContext.extra = 'must reject';
  assert.match(validateValidatePowerAppsChangeParams(extra), /未対応/);

  const badSha = validParams();
  badSha.stateContext.sha = 'not-a-blob-sha';
  assert.match(validateValidatePowerAppsChangeParams(badSha), /40桁/);
});

test('validate_powerapps_change remains strict about unknown top-level properties', () => {
  const params = validParams();
  params.version = 'invented';
  assert.match(validateValidatePowerAppsChangeParams(params), /未対応/);
});
