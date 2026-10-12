const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { collectRuntimeEvidence } = require('../src/azureRuntimeEvidence');
const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-production-bridge.js'), 'utf8');

test('independent Azure deployment metadata is used, never GitHub SHA as deployed SHA', () => {
  assert.ok(source.includes('activeDeployment.commitSha'));
  assert.match(source, /independentAzureSource: azureDeploymentSha !== null/);
  assert.doesNotMatch(source, /azureDeployedSha: process\.env\.GITHUB_SHA/);
});
test('missing independent deployment SHA fails closed', () => {
  const expectedSha = 'a'.repeat(40);
  assert.equal(collectRuntimeEvidence({ deployment: { expectedSha } }).deploymentShaMatched, false);
});
test('remote MCP source cannot assert trusted adapter provenance', () => {
  const probe = { status: 'ok', source: 'power-apps-saved-msapp', runtimeHash: 'b'.repeat(64) };
  assert.equal(collectRuntimeEvidence({ pacProbe: probe }).pacProfileVerified, false);
  assert.match(source, /const sourceProbe = null/);
});

test('opaque deployment ID cannot be interpreted as Git commit', () => {
  assert.ok(!source.includes('shaPattern.test(d.id'));
  assert.ok(source.includes('commitSha: typeof d.commitSha'));
});
test('trusted PAC evidence must match app and environment', () => {
  const appId = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
  const probe = { trustedAdapterVerified: true, status: 'ok', source: 'power-apps-saved-msapp',
    runtimeHash: 'a'.repeat(64), appId, expectedAppId: appId,
    environment: 'env-1', expectedEnvironment: 'env-1' };
  assert.equal(collectRuntimeEvidence({ pacProbe: probe }).pacProfileVerified, true);
  assert.equal(collectRuntimeEvidence({ pacProbe: { ...probe, expectedEnvironment: 'env-2' } }).pacProfileVerified, false);
});

test('PAC evidence rejects an overridden reader rather than trusting injected source', async () => {
  const { PowerAppsRuntimeSourceAdapter } = require('../src/powerAppsRuntimeSource');
  const appId = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
  const adapter = new PowerAppsRuntimeSourceAdapter({ appId, environmentId: 'env-1' });
  adapter.getSourceFile = async () => ({ status: 'ok', source: 'power-apps-saved-msapp',
    appId, environment: 'env-1', runtimeHash: 'b'.repeat(64), content: 'forged source' });
  await assert.rejects(adapter.getSourceEvidence('S1_Home.pa.yaml', {}), /対象照合/);
});

test('Azure standard deployment fields alone cannot establish Git SHA', () => {
  const azureDeployment = { id: 'a'.repeat(40), active: true, status: 4,
    message: 'deployment complete', details: 'deployed' };
  const deployment = { azureDeployedSha: azureDeployment.commitSha || null,
    expectedSha: 'a'.repeat(40), independentAzureSource: false };
  assert.equal(collectRuntimeEvidence({ deployment }).deploymentShaMatched, false);
});

test('PAC source evidence requires registered State Manager callback', async () => {
  const { PowerAppsRuntimeSourceAdapter } = require('../src/powerAppsRuntimeSource');
  const adapter = new PowerAppsRuntimeSourceAdapter({ appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
    environmentId: 'env-1', mode: 'pac' });
  await assert.rejects(adapter.getSourceEvidence('S1_Home.pa.yaml', {}));
});

test('registered State Manager evidence bridge revalidates before and after read', async () => {
  const { readPacEvidenceWithRegisteredState } = require('../src/pacStateEvidence');
  const record = { context: { appId: 'app' }, source: { path: 'S1_Home.pa.yaml' } };
  let checks = 0;
  const adapter = { getSourceEvidence: async (path, options) => {
    assert.equal(path, record.source.path);
    assert.equal(options.stateContext, record.context);
    options.assertStateContext();
    return { status: 'ok', trustedAdapterVerified: true };
  } };
  const evidence = await readPacEvidenceWithRegisteredState({
    adapter, registeredRecord: record, relativePath: record.source.path,
    validateRegisteredState: () => { checks++; return record; }
  });
  assert.equal(evidence.status, 'ok');
  assert.equal(checks, 3);
  await assert.rejects(readPacEvidenceWithRegisteredState({
    adapter, registeredRecord: record, relativePath: '../other.pa.yaml',
    validateRegisteredState: () => record
  }));
  await assert.rejects(readPacEvidenceWithRegisteredState({
    adapter, registeredRecord: record, relativePath: record.source.path,
    validateRegisteredState: () => ({ context: { appId: 'app' }, source: record.source })
  }));
});

test('PAC comparison hook is internal-only and requires registered state validation', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(server, /readPacEvidenceWithRegisteredState\(/);
  assert.match(server, /internalPacAdapter instanceof PowerAppsRuntimeSourceAdapter/);
  assert.match(server, /validateRegisteredState: \(\) => stateRegistry\.validate/);
  assert.doesNotMatch(server, /params\.runtimeSourceAdapter/);
});

test('comparison PAC evidence is wired to the PowerAppsStore internal adapter', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const store = fs.readFileSync(path.join(__dirname, '../src/powerAppsStore.js'), 'utf8');
  assert.ok(store.includes('this._runtimeSource = new PowerAppsRuntimeSourceAdapter('));
  assert.ok(server.includes('const internalPacAdapter = powerAppsStore._runtimeSource;'));
  assert.ok(server.includes('readPacEvidenceWithRegisteredState({'));
  assert.ok(server.includes('validateRegisteredState: () => stateRegistry.validate('));
  assert.ok(!server.includes('powerAppsStore.runtimeSourceAdapter'));
});

test('effective RBAC remains unverified even with apparent Azure metadata and PAC proof', () => {
  const appId = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
  const result = collectRuntimeEvidence({
    settings: { POWERAPPS_RUNTIME_AUTH_MODE: 'managedIdentity' },
    deployment: { azureDeployedSha: 'a'.repeat(40), expectedSha: 'a'.repeat(40),
      independentAzureSource: true },
    pacProbe: { trustedAdapterVerified: true, status: 'ok', source: 'power-apps-saved-msapp',
      runtimeHash: 'b'.repeat(64), appId, expectedAppId: appId,
      environment: 'env-1', expectedEnvironment: 'env-1' }
  });
  assert.equal(result.deploymentShaMatched, true);
  assert.equal(result.effectiveRbacVerified, false);
});

test('no PAC profile or source-map readiness without in-process trusted observation', () => {
  const result = collectRuntimeEvidence({
    settings: { POWERAPPS_RUNTIME_AUTH_MODE: 'managedIdentity',
      POWERAPPS_RUNTIME_SOURCE_MAP: JSON.stringify({ 'S1_Home.pa.yaml': 'Src/S1_Home.pa.yaml' }) },
    pacProbe: null
  });
  assert.equal(result.managedIdentityModeConfigured, true);
  assert.equal(result.pacProfileVerified, false);
  assert.equal(result.sourceMapVerified, false);
  assert.equal(result.deploymentShaMatched, false);
  assert.equal(result.effectiveRbacVerified, false);
});

test('metadata-only Azure probe never retrieves secrets or claims effective RBAC', () => {
  const metadata = fs.readFileSync(path.join(__dirname, '../scripts/check-azure-metadata-only.js'), 'utf8');
  assert.ok(metadata.includes("['webapp', 'identity', 'show'"));
  assert.ok(metadata.includes("['webapp', 'log', 'deployment', 'list'"));
  assert.doesNotMatch(metadata, /appsettings|list-secrets|access-token|role', 'assignment'|config', 'appsettings'/);
  assert.ok(metadata.includes('deploymentShaMatched: false'));
  assert.ok(metadata.includes('effectiveRbacVerified: false'));
  assert.ok(metadata.includes('pacRuntimeVerified: false'));
  const legacy = fs.readFileSync(path.join(__dirname, '../scripts/verify-production-bridge.js'), 'utf8');
  assert.ok(legacy.includes('observed.rbacReadVerified = false'));
  assert.ok(!legacy.includes('observed.rbacReadVerified = Array.isArray(assignments)'));
});


test('Azure metadata MCP tool is registered and fail closed without a trusted reader', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.ok(server.includes("'get_azure_deployment_metadata'"));
  assert.ok(server.includes("reason: 'azure_metadata_reader_unavailable'"));
  assert.ok(server.includes('deploymentShaMatched: false'));
  assert.ok(server.includes('effectiveRbacVerified: false'));
  assert.ok(server.includes('pacRuntimeVerified: false'));
});
