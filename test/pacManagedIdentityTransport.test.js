const test = require('node:test');
const assert = require('node:assert/strict');
const { pacWorkerEnvironment } = require('../src/powerAppsRuntimeSource');

const config = { authMode: 'managedIdentity', pacProfileHome: '/dedicated/pac' };
const identity = {
  IDENTITY_ENDPOINT: 'http://127.0.0.1:42000/MSI/token/',
  IDENTITY_HEADER: 'synthetic-host-header'
};

test('App Service MI transport survives child isolation without inheriting other credentials', () => {
  const parent = { ...identity, AZURE_CLIENT_ID: 'old-client', AZURE_CLIENT_SECRET: 'old-secret',
    AZURE_TENANT_ID: 'old-tenant', AZURE_FEDERATED_TOKEN_FILE: '/old/token',
    MSI_ENDPOINT: 'http://legacy/', MSI_SECRET: 'legacy-secret', MCP_API_KEY: 'bridge-key' };
  const clientId = '11111111-2222-3333-4444-555555555555';
  const env = pacWorkerEnvironment({ ...config, managedIdentityClientId: clientId }, parent);
  for (const key of Object.keys(identity)) assert.equal(env[key], identity[key]);
  assert.equal(env.AZURE_CLIENT_ID, clientId);
  assert.equal(env.AZURE_TOKEN_CREDENTIALS, 'ManagedIdentityCredential');
  for (const key of ['AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'AZURE_FEDERATED_TOKEN_FILE',
    'MSI_ENDPOINT', 'MSI_SECRET', 'MCP_API_KEY']) assert.equal(env[key], undefined);
  assert.equal(parent.AZURE_CLIENT_ID, 'old-client');
});

test('partial App Service transport fails closed without exposing host values', () => {
  for (const parent of [{ IDENTITY_ENDPOINT: identity.IDENTITY_ENDPOINT },
    { IDENTITY_HEADER: identity.IDENTITY_HEADER }, { ...identity, IDENTITY_HEADER: '' },
    { ...identity, IDENTITY_ENDPOINT: ' ' }]) {
    assert.throws(() => pacWorkerEnvironment(config, parent), error => {
      assert.equal(error.payload.reason, 'managed_identity_transport_incomplete');
      assert.doesNotMatch(error.message + JSON.stringify(error.payload), /synthetic-host-header|127\.0\.0\.1/);
      return true;
    });
  }
});

test('system MI does not acquire a parent client ID and non-App-Service hosts remain supported', () => {
  const env = pacWorkerEnvironment(config, { ...identity, AZURE_CLIENT_ID: 'old-client' });
  assert.equal(env.AZURE_CLIENT_ID, undefined);
  const other = pacWorkerEnvironment(config, { PATH: '/usr/bin' });
  assert.equal(other.IDENTITY_ENDPOINT, undefined);
  assert.equal(other.IDENTITY_HEADER, undefined);
});
