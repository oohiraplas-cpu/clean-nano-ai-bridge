const assert = require('node:assert');
const { test } = require('node:test');
const {
  FAIL_CLOSED_TOOLS,
  REQUIRED_STATE_FIELDS,
  validateStateContext,
  createStateValidationError,
  extractStateContext,
  enrichResponseWithState
} = require('../src/stateManager');

test('State Manager - FAIL_CLOSED_TOOLS list', () => {
  assert(Array.isArray(FAIL_CLOSED_TOOLS));
  assert(FAIL_CLOSED_TOOLS.length === 16);
  assert(FAIL_CLOSED_TOOLS.includes('update_powerapps_app'));
  assert(FAIL_CLOSED_TOOLS.includes('publish_powerapps_app'));
  assert(FAIL_CLOSED_TOOLS.includes('deploy_to_test'));
  assert(FAIL_CLOSED_TOOLS.includes('update_permissions'));
});

test('State Manager - REQUIRED_STATE_FIELDS', () => {
  assert(Array.isArray(REQUIRED_STATE_FIELDS));
  assert(REQUIRED_STATE_FIELDS.includes('appId'));
  assert(REQUIRED_STATE_FIELDS.includes('environment'));
  assert(REQUIRED_STATE_FIELDS.includes('branch'));
  assert(REQUIRED_STATE_FIELDS.includes('canonicalBranch'));
  assert(REQUIRED_STATE_FIELDS.includes('sha'));
  assert(REQUIRED_STATE_FIELDS.includes('correlationId'));
});

test('State Manager - validateStateContext: read operation (no validation needed)', () => {
  const validation = validateStateContext('get_powerapps_app', {}, {});
  assert(validation.isValid === true);
  assert(validation.errors.length === 0);
});

test('State Manager - validateStateContext: write operation with complete state', () => {
  const stateContext = {
    appId: 'app-123',
    environment: 'Default-abc123',
    branch: 'main',
    canonicalBranch: 'main',
    sha: '1234567890abcdef1234567890abcdef12345678', // Valid 40-character hex
    correlationId: 'req-12345678'
  };

  const validation = validateStateContext('update_powerapps_app', {}, stateContext);
  assert(validation.isValid === true);
  assert(validation.errors.length === 0);
});

test('State Manager - validateStateContext: missing state context', () => {
  const validation = validateStateContext('update_powerapps_app', {}, {});
  assert(validation.isValid === false);
  assert(validation.errors.length > 0);
  assert(validation.errors.some(e => e.includes('appId')));
});

test('State Manager - validateStateContext: invalid SHA', () => {
  const stateContext = {
    appId: 'app-123',
    environment: 'Default-abc123',
    branch: 'main',
    canonicalBranch: 'main',
    sha: 'invalid_sha_not_hex',  // Not 40 hex characters
    correlationId: 'req-12345678'
  };

  const validation = validateStateContext('update_powerapps_app', {}, stateContext);
  assert(validation.isValid === false);
  assert(validation.errors.some(e => e.includes('sha')));
});

test('State Manager - validateStateContext: branch mismatch', () => {
  const stateContext = {
    appId: 'app-123',
    environment: 'Default-abc123',
    branch: 'feature/xyz',      // Does not match canonical
    canonicalBranch: 'main',
    sha: '1234567890abcdef1234567890abcdef12345678',
    correlationId: 'req-12345678'
  };

  const validation = validateStateContext('update_powerapps_app', {}, stateContext);
  assert(validation.isValid === false);
  assert(validation.errors.some(e => e.includes('branch mismatch')));
});

test('State Manager - validateStateContext: empty string fields', () => {
  const stateContext = {
    appId: '',  // Empty
    environment: 'Default-abc123',
    branch: 'main',
    canonicalBranch: 'main',
    sha: '1234567890abcdef1234567890abcdef12345678',
    correlationId: 'req-12345678'
  };

  const validation = validateStateContext('update_powerapps_app', {}, stateContext);
  assert(validation.isValid === false);
  assert(validation.errors.some(e => e.includes('appId')));
});

test('State Manager - createStateValidationError', () => {
  const { StateValidationResult } = require('../src/stateManager');
  const validation = new StateValidationResult(false, ['appId: missing']);
  const error = createStateValidationError(validation, 'update_powerapps_app');

  assert.strictEqual(error.status, 400);
  assert(error.message.includes('State Manager検証エラー'));
  assert(error.details.method === 'update_powerapps_app');
  assert(Array.isArray(error.details.failures));
  assert(error.details.failedClosedTool === true);
});

test('State Manager - extractStateContext: direct stateContext property', () => {
  const params = {
    stateContext: {
      appId: 'app-123',
      environment: 'Default-abc123',
      branch: 'main',
      canonicalBranch: 'main',
      sha: '1234567890abcdef1234567890abcdef12345678',
      correlationId: 'req-12345678'
    }
  };

  const context = extractStateContext(params);
  assert.deepStrictEqual(context, params.stateContext);
});

test('State Manager - extractStateContext: inline state fields', () => {
  const params = {
    appId: 'app-123',
    environment: 'Default-abc123',
    branch: 'main',
    canonicalBranch: 'main',
    sha: '1234567890abcdef1234567890abcdef12345678',
    correlationId: 'req-12345678',
    otherParam: 'value'
  };

  const context = extractStateContext(params);
  assert(context !== null);
  assert.strictEqual(context.appId, 'app-123');
  assert.strictEqual(context.environment, 'Default-abc123');
  assert.strictEqual(context.branch, 'main');
});

test('State Manager - extractStateContext: nested in payload', () => {
  const params = {
    payload: {
      stateContext: {
        appId: 'app-123',
        environment: 'Default-abc123',
        branch: 'main',
        canonicalBranch: 'main',
        sha: '1234567890abcdef1234567890abcdef12345678',
        correlationId: 'req-12345678'
      }
    }
  };

  const context = extractStateContext(params);
  assert.deepStrictEqual(context, params.payload.stateContext);
});

test('State Manager - extractStateContext: not provided', () => {
  const params = { someOtherParam: 'value' };
  const context = extractStateContext(params);
  assert.strictEqual(context, null);
});

test('State Manager - enrichResponseWithState', () => {
  const response = { status: 'ok', data: 'test' };
  const stateContext = {
    appId: 'app-123',
    environment: 'Default-abc123',
    branch: 'main',
    sha: '1234567890abcdef1234567890abcdef12345678',
    correlationId: 'req-12345678'
  };

  const enriched = enrichResponseWithState(response, stateContext);
  assert(enriched._stateManager !== undefined);
  assert.strictEqual(enriched._stateManager.appId, 'app-123');
  assert.strictEqual(enriched._stateManager.correlationId, 'req-12345678');
  assert(enriched._stateManager.timestamp !== undefined);
  assert.strictEqual(enriched.status, 'ok');
  assert.strictEqual(enriched.data, 'test');
});

test('State Manager - enrichResponseWithState: no state context', () => {
  const response = { status: 'ok' };
  const enriched = enrichResponseWithState(response, null);
  assert.deepStrictEqual(enriched, response);
});

test('State Manager - all write tools listed', () => {
  const writeOps = [
    'update_powerapps_app',
    'save_powerapps_app',
    'publish_powerapps_app',
    'ensure_sharepoint_columns',
    'create_employee_ledger_entry',
    'update_employee_ledger_entry',
    'run_power_automate_flow',
    'validate_powerapps_change',
    'verify_save_result',
    'deploy_to_test',
    'rollback_deployment',
    'update_permissions',
    'lock_user_info',
    'validate_powerapps_source',
    'compare_powerapps_with_git',
    'run_powerapps_tests'
  ];

  for (const op of writeOps) {
    assert(FAIL_CLOSED_TOOLS.includes(op), `${op} should be in FAIL_CLOSED_TOOLS`);
  }
});
