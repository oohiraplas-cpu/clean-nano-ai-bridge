const test = require('node:test');
const assert = require('node:assert');
const { ProhibitedOperationsEngine } = require('../src/prohibitedOperationsEngine.js');

test('ProhibitedOperationsEngine - initialization', (t) => {
  const engine = new ProhibitedOperationsEngine();
  assert.ok(engine, 'Engine instantiated');
  assert.equal(engine.prohibitedCategories.length, 10, '10 prohibition categories registered');
});

// Test 1: Production deployment prohibition
test('checkProductionDeployment - non-prod deploy allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkProductionDeployment('deploy_to_test', null, 'test');
  assert.equal(result.blocked, false, 'non-production deploy allowed');
});

test('checkProductionDeployment - prod deploy without approval blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkProductionDeployment('publish_powerapps_app', null, '本番');
  assert.equal(result.blocked, true, 'production deploy without approval blocked');
  assert.equal(result.requiredApproval, true);
});

test('checkProductionDeployment - prod deploy with approval allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkProductionDeployment('deploy_to_test', 'valid-approval-token-abc123def456', 'production');
  assert.equal(result.blocked, false, 'production deploy with approval allowed');
  assert.equal(result.approvalProvided, true);
});

// Test 2: Main branch modification prohibition
test('checkMainBranchModification - non-main modification allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkMainBranchModification('save_powerapps_app', 'dev', null);
  assert.equal(result.blocked, false, 'non-main branch modification allowed');
});

test('checkMainBranchModification - main modification without approval blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkMainBranchModification('save_powerapps_app', 'main', null);
  assert.equal(result.blocked, true, 'main branch modification without approval blocked');
});

test('checkMainBranchModification - main modification with approval allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkMainBranchModification('update_powerapps_app', 'master', 'approval-token-xyz789');
  assert.equal(result.blocked, false, 'main branch modification with approval allowed');
});

// Test 3: Permission change prohibition
test('checkPermissionChange - non-permission operation allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkPermissionChange('get_permissions', null);
  assert.equal(result.blocked, false, 'non-permission operation allowed');
});

test('checkPermissionChange - permission change without approval blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkPermissionChange('update_permissions', null);
  assert.equal(result.blocked, true, 'permission change without approval blocked');
  assert.equal(result.category, 'permission_change');
});

test('checkPermissionChange - permission change with approval allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkPermissionChange('grant_role', 'approval-token-valid123');
  assert.equal(result.blocked, false, 'permission change with approval allowed');
});

// Test 4: Deletion prohibition
test('checkDeletion - non-deletion operation allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkDeletion('update_app', null, null);
  assert.equal(result.blocked, false, 'non-deletion operation allowed');
});

test('checkDeletion - deletion without approval blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkDeletion('delete_app', 'MyApp', null);
  assert.equal(result.blocked, true, 'deletion without approval blocked');
  assert.equal(result.category, 'deletion');
  assert.equal(result.warning, '削除操作は不可逆です。バックアップを確認してください。');
});

test('checkDeletion - deletion with approval allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkDeletion('delete_solution', 'OldSolution', 'delete-approval-token-123');
  assert.equal(result.blocked, false, 'deletion with approval allowed');
});

// Test 5: Secret modification prohibition
test('checkSecretModification - non-secret operation allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkSecretModification('update_app', ['title', 'description']);
  assert.equal(result.blocked, false, 'non-secret operation allowed');
});

test('checkSecretModification - secret parameter blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkSecretModification('update_config', ['api_key', 'connection_string']);
  assert.equal(result.blocked, true, 'operation with secret params blocked');
  assert.equal(result.category, 'secret_modification');
});

test('checkSecretModification - rotate_api_key blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkSecretModification('rotate_api_key', []);
  assert.equal(result.blocked, true, 'secret rotation blocked');
});

// Test 6: External sharing prohibition
test('checkExternalSharing - internal sharing allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkExternalSharing('share_app', 'internal', 'internal');
  assert.equal(result.blocked, false, 'internal sharing allowed');
});

test('checkExternalSharing - external sharing blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkExternalSharing('create_shared_link', 'public', 'internal');
  assert.equal(result.blocked, true, 'external sharing blocked');
  assert.equal(result.category, 'external_sharing');
});

test('checkExternalSharing - non-sharing operation allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkExternalSharing('get_app', 'public', 'internal');
  assert.equal(result.blocked, false, 'non-sharing operation allowed');
});

// Test 7: Billing change prohibition
test('checkBillingChange - non-billing operation allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkBillingChange('get_license_info', null);
  assert.equal(result.blocked, false, 'non-billing operation allowed');
});

test('checkBillingChange - billing change without approval blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkBillingChange('upgrade_license', null);
  assert.equal(result.blocked, true, 'billing change without approval blocked');
  assert.equal(result.category, 'billing_change');
});

test('checkBillingChange - billing change with approval allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkBillingChange('add_seats', 'billing-approval-token-456');
  assert.equal(result.blocked, false, 'billing change with approval allowed');
});

// Test 8: Solution export prohibition
test('checkSolutionExport - non-export operation allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkSolutionExport('get_solution', null);
  assert.equal(result.blocked, false, 'non-export operation allowed');
});

test('checkSolutionExport - export without approval blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkSolutionExport('export_solution', null);
  assert.equal(result.blocked, true, 'export without approval blocked');
  assert.equal(result.category, 'solution_export');
});

test('checkSolutionExport - export with approval allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkSolutionExport('backup_solution', 'export-approval-token-789');
  assert.equal(result.blocked, false, 'export with approval allowed');
});

// Test 9: Data backup/export prohibition
test('checkDataBackupExport - non-export operation allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkDataBackupExport('get_records');
  assert.equal(result.blocked, false, 'non-export operation allowed');
});

test('checkDataBackupExport - data export always blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkDataBackupExport('export_data');
  assert.equal(result.blocked, true, 'data export always blocked');
  assert.equal(result.category, 'data_backup_export');
});

test('checkDataBackupExport - backup always blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkDataBackupExport('backup_database');
  assert.equal(result.blocked, true, 'backup always blocked');
});

// Test 10: Cross-environment promotion prohibition
test('checkCrossEnvironmentPromotion - non-promotion allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkCrossEnvironmentPromotion('get_solution', 'dev', 'test', null);
  assert.equal(result.blocked, false, 'non-promotion allowed');
});

test('checkCrossEnvironmentPromotion - dev-to-test allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkCrossEnvironmentPromotion('promote_solution', 'dev', 'test', null);
  assert.equal(result.blocked, false, 'dev-to-test promotion allowed without approval');
});

test('checkCrossEnvironmentPromotion - to-production without approval blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkCrossEnvironmentPromotion('deploy_to_production', 'test', '本番', null);
  assert.equal(result.blocked, true, 'promotion to production without approval blocked');
  assert.equal(result.category, 'cross_environment_promotion');
});

test('checkCrossEnvironmentPromotion - to-production with approval allowed', (t) => {
  const engine = new ProhibitedOperationsEngine();
  const result = engine.checkCrossEnvironmentPromotion('deploy_to_production', 'test', 'production', 'promotion-approval-token-abc');
  assert.equal(result.blocked, false, 'promotion to production with approval allowed');
});

// Integration tests: Full check
test('check - multiple violations detected', (t) => {
  const engine = new ProhibitedOperationsEngine();

  const result = engine.check({
    operation: 'delete_app',
    approvalToken: null,
    environment: '本番',
    targetBranch: 'main',
    targetName: 'CriticalApp',
    paramKeys: [],
    targetScope: null,
    currentScope: 'internal',
    sourceEnv: 'test',
    targetEnv: 'production'
  });

  assert.equal(result.allowed, false, 'operation blocked due to multiple violations');
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.violations.length > 0, 'violations detected');
  assert.ok(result.reasons.length > 0, 'reasons provided');
});

test('check - single violation blocks operation', (t) => {
  const engine = new ProhibitedOperationsEngine();

  const result = engine.check({
    operation: 'update_permissions',
    approvalToken: null,
    environment: 'test',
    targetBranch: 'dev',
    targetName: null,
    paramKeys: [],
    targetScope: null,
    currentScope: null,
    sourceEnv: null,
    targetEnv: null
  });

  assert.equal(result.allowed, false, 'operation blocked');
  assert.equal(result.blocked, true);
  assert.equal(result.checksPerformed, 10, 'all 10 checks performed');
  assert.ok(result.checksBlocked >= 1, 'at least 1 check blocked');
});

test('check - approval token satisfies requirement', (t) => {
  const engine = new ProhibitedOperationsEngine();

  const result = engine.check({
    operation: 'publish_powerapps_app',
    approvalToken: 'valid-approval-token-12345',
    environment: '本番',
    targetBranch: 'main',
    targetName: 'ProdApp',
    paramKeys: [],
    targetScope: null,
    currentScope: null,
    sourceEnv: null,
    targetEnv: null
  });

  assert.equal(result.allowed, true, 'operation allowed with valid approval');
  assert.equal(result.verdict, 'ALLOWED');
  assert.equal(result.blocked, false);
});

test('check - includes metadata in result', (t) => {
  const engine = new ProhibitedOperationsEngine();

  const result = engine.check({
    operation: 'get_app',
    approvalToken: null,
    environment: 'test',
    targetBranch: null,
    targetName: null,
    paramKeys: [],
    targetScope: null,
    currentScope: null,
    sourceEnv: null,
    targetEnv: null
  });

  assert.ok(result.timestamp, 'includes timestamp');
  assert.ok(result.assessmentId, 'includes assessment ID');
  assert.ok(Array.isArray(result.violations), 'violations is array');
  assert.ok(Array.isArray(result.reasons), 'reasons is array');
  assert.ok(result.evidence, 'includes evidence');
});

test('check - secret in params triggers block', (t) => {
  const engine = new ProhibitedOperationsEngine();

  const result = engine.check({
    operation: 'update_connection',
    approvalToken: null,
    environment: 'test',
    targetBranch: null,
    targetName: 'MyConnection',
    paramKeys: ['username', 'password', 'api_key'],
    targetScope: null,
    currentScope: null,
    sourceEnv: null,
    targetEnv: null
  });

  assert.equal(result.allowed, false, 'operation blocked due to secret params');
  assert.ok(result.violations.includes('secret_modification'), 'secret_modification violation detected');
});

test('check - data export always blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();

  const result = engine.check({
    operation: 'export_data',
    approvalToken: 'even-with-approval-token-xyz',
    environment: 'test',
    targetBranch: null,
    targetName: null,
    paramKeys: [],
    targetScope: null,
    currentScope: null,
    sourceEnv: null,
    targetEnv: null
  });

  assert.equal(result.allowed, false, 'data export always blocked');
  assert.ok(result.violations.includes('data_backup_export'));
});

test('check - external sharing always blocked', (t) => {
  const engine = new ProhibitedOperationsEngine();

  const result = engine.check({
    operation: 'grant_external_access',
    approvalToken: 'approval-token-abc',
    environment: 'test',
    targetBranch: null,
    targetName: 'MyApp',
    paramKeys: [],
    targetScope: 'public',
    currentScope: 'internal',
    sourceEnv: null,
    targetEnv: null
  });

  assert.equal(result.allowed, false, 'external sharing always blocked');
  assert.ok(result.violations.includes('external_sharing'));
});
