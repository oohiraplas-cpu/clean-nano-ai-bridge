'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MCP_METHODS, MCP_PUBLIC_TOOLS } = require('../src/server');
const { runtimeConfigurationStatus } = require('../src/azureRuntimeDiagnostics');

test('read-only Azure diagnostic is registered in MCP and has no input parameters', () => {
  assert.ok(MCP_METHODS.includes('get_azure_runtime_diagnostics'));
  const tool = MCP_PUBLIC_TOOLS.find(t => t.name === 'get_azure_runtime_diagnostics');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema, {type:'object',properties:{},additionalProperties:false});
});
test('MCP diagnostic payload never returns environment variable values', () => {
  const result = runtimeConfigurationStatus({
    POWERAPPS_RUNTIME_SOURCE_ADAPTER: 'pac',
    POWERAPPS_RUNTIME_AUTH_MODE: 'managedIdentity',
    POWERAPPS_RUNTIME_PAC_PROFILE_HOME: '/secret/home',
    POWERAPPS_RUNTIME_SOURCE_MAP: '{"a":"private"}'
  });
  assert.equal(result.status, 'presence_only');
  assert.equal(result.azureIdentity, 'unverified');
  assert.equal(result.pacAuthentication, 'unverified');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('/secret/home'));
});
