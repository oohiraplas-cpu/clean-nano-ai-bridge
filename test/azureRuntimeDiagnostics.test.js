'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeConfigurationStatus } = require('../src/azureRuntimeDiagnostics');

test('fail-closed when runtime configuration is absent', () => {
  const result = runtimeConfigurationStatus({});
  assert.equal(result.status, 'missing_configuration');
  assert.equal(result.azureIdentity, 'unverified');
  assert.equal(result.runtimeSourceObserved, false);
});
test('only reports presence, never secret values', () => {
  const env = {
    POWERAPPS_RUNTIME_SOURCE_ADAPTER: 'pac',
    POWERAPPS_RUNTIME_AUTH_MODE: 'managedIdentity',
    POWERAPPS_RUNTIME_PAC_PROFILE_HOME: '/private/profile',
    POWERAPPS_RUNTIME_SOURCE_MAP: '{"secret":"do-not-leak"}',
    POWERAPPS_RUNTIME_MI_CLIENT_ID: 'sensitive-identifier'
  };
  const result = runtimeConfigurationStatus(env);
  assert.equal(result.status, 'presence_only');
  assert.equal(result.keys.POWERAPPS_RUNTIME_MI_CLIENT_ID, 'present');
  assert.equal(JSON.stringify(result).includes('do-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('sensitive-identifier'), false);
  assert.equal(result.pacAuthentication, 'unverified');
});
test('whitespace-only settings are missing', () => {
  const result = runtimeConfigurationStatus({ POWERAPPS_RUNTIME_SOURCE_ADAPTER: '  ' });
  assert.equal(result.keys.POWERAPPS_RUNTIME_SOURCE_ADAPTER, 'missing');
});
