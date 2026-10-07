/**
 * State Manager for Bridge MCP
 *
 * Enforces mandatory state context (AppID, Environment, Branch, SHA, CorrelationID)
 * before permitting write operations. Implements Fail-Closed security principle:
 * writes are prohibited unless all state fields are explicitly provided and validated.
 *
 * Reference: CLAUDE.md - 3AI共通Bridge実行規則（2026-10-07）
 * "不足時: 書込み禁止" (When insufficient: prohibit writes)
 */

const crypto = require('node:crypto');
const { STATE_CONTEXT_SCHEMA, REQUIRED_STATE_FIELDS } = require('./stateContext');

/**
 * Tools that require State Manager validation before execution (Fail-Closed writes)
 * According to Bridge MCP Inventory v1.1.0, these 16 tools modify state:
 */
const FAIL_CLOSED_TOOLS = [
  'update_powerapps_app',           // Updates Power Apps source/app
  'save_powerapps_app',              // Saves Power Apps to Power Platform
  'publish_powerapps_app',           // Publishes Power Apps
  'ensure_sharepoint_columns',       // Creates new SharePoint columns
  'create_employee_ledger_entry',    // Creates new SharePoint item
  'update_employee_ledger_entry',    // Updates existing SharePoint item
  'run_power_automate_flow',         // Executes Power Automate flow
  'validate_powerapps_change',       // Validates changes (may trigger remediation)
  'verify_save_result',              // Verifies and may update state
  'deploy_to_test',                  // Deploys to test environment
  'rollback_deployment',             // Rolls back production deployment
  'update_permissions',              // Changes RBAC permissions
  'lock_user_info',                  // Locks user information
  'validate_powerapps_source',       // Validates source (may log changes)
  'compare_powerapps_with_git',      // Compares state (may trigger sync)
  'run_powerapps_tests'              // Runs tests (side effects possible)
];

/**
 * Required State Manager fields for write operations.
 * These must be explicitly provided by the caller and validated.
 */

/**
 * Validation result for state context
 */
class StateValidationResult {
  constructor(isValid, errors = []) {
    this.isValid = isValid;
    this.errors = errors;
    this.message = isValid
      ? null
      : `State Manager validation failed: ${errors.join('; ')}`;
  }
}

/**
 * Validates State Manager context before write operation
 *
 * @param {string} method - MCP method name (tool identifier)
 * @param {object} params - Method parameters from client
 * @param {object} stateContext - State context to validate against:
 *   - appId: required, non-empty string
 *   - environment: required, non-empty string
 *   - branch: required, non-empty string
 *   - canonicalBranch: required, non-empty string (must match branch)
 *   - sha: required, 40-character hex string
 *   - correlationId: required, non-empty string (UUID or similar)
 * @returns {StateValidationResult}
 */
function validateStateContext(method, params, stateContext = {}) {
  if (!FAIL_CLOSED_TOOLS.includes(method)) {
    // Non-write operation: no state validation required
    return new StateValidationResult(true);
  }

  const errors = [];

  // Check that stateContext is provided
  if (!stateContext || typeof stateContext !== 'object') {
    return new StateValidationResult(false, ['State context object required']);
  }

  // Validate each required field
  for (const field of REQUIRED_STATE_FIELDS) {
    const value = stateContext[field];

    if (value === undefined || value === null) {
      errors.push(`${field}: missing`);
      continue;
    }

    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${field}: empty or invalid`);
      continue;
    }

    // Additional validations for specific fields
    if (field === 'sha' && !/^[a-f0-9]{40}$/.test(value)) {
      errors.push(`${field}: must be 40-character hex string (got: ${value.substring(0, 8)}...)`);
    }

    if (field === 'correlationId' && value.length < 8) {
      errors.push(`${field}: too short (minimum 8 characters)`);
    }
  }

  // Special validation: branch must match canonicalBranch
  if (stateContext.branch && stateContext.canonicalBranch) {
    if (stateContext.branch !== stateContext.canonicalBranch) {
      errors.push(`branch mismatch: branch="${stateContext.branch}" != canonicalBranch="${stateContext.canonicalBranch}"`);
    }
  }

  return new StateValidationResult(errors.length === 0, errors);
}

/**
 * Creates a standardized error response for state validation failures
 * Follows Bridge error conventions (Japanese messages, structured payload)
 *
 * @param {StateValidationResult} validation
 * @param {string} method
 * @returns {object}
 */
function createStateValidationError(validation, method) {
  return {
    status: 400,
    message: `State Manager検証エラー: ${method}の実行には完全な状態コンテキストが必須です。`,
    details: {
      method,
      failures: validation.errors,
      required: REQUIRED_STATE_FIELDS,
      failedClosedTool: FAIL_CLOSED_TOOLS.includes(method),
      policy: 'Fail-Closed: state context validation required before write'
    }
  };
}

/**
 * Extracts State Manager context from MCP request.
 * Supports multiple input patterns:
 * - Direct: params = { stateContext: { appId, environment, ... } }
 * - Inline: params = { appId, environment, ... }
 * - Nested in payload: params = { payload: { stateContext: { ... } } }
 *
 * @param {object} params - Method parameters
 * @returns {object|null}
 */
function extractStateContext(params = {}) {
  if (!params || typeof params !== 'object') return null;

  // Pattern 1: Explicit stateContext property
  if (params.stateContext && typeof params.stateContext === 'object') {
    return params.stateContext;
  }

  // Pattern 2: Inline state fields in params
  const hasInlineFields = REQUIRED_STATE_FIELDS.some(field => field in params);
  if (hasInlineFields) {
    const context = {};
    for (const field of REQUIRED_STATE_FIELDS) {
      if (field in params) {
        context[field] = params[field];
      }
    }
    return context;
  }

  // Pattern 3: Nested in payload
  if (params.payload && typeof params.payload === 'object') {
    if (params.payload.stateContext) {
      return params.payload.stateContext;
    }
    // Also check for inline in payload
    const hasPayloadFields = REQUIRED_STATE_FIELDS.some(field => field in params.payload);
    if (hasPayloadFields) {
      const context = {};
      for (const field of REQUIRED_STATE_FIELDS) {
        if (field in params.payload) {
          context[field] = params.payload[field];
        }
      }
      return context;
    }
  }

  return null;
}

/**
 * Generates a new CorrelationID for tracking a request through the system.
 * Used when state context doesn't provide one.
 *
 * @returns {string} UUID v4-like correlation ID
 */
function generateCorrelationId() {
  return crypto.randomUUID();
}

/**
 * Enriches response with State Manager metadata for audit trail
 *
 * @param {object} response - Tool execution result
 * @param {object} stateContext - State context used for execution
 * @returns {object} Enhanced response with _stateManager field
 */
function enrichResponseWithState(response = {}, stateContext = {}) {
  if (!stateContext || typeof stateContext !== 'object') {
    return response;
  }

  return {
    ...response,
    _stateManager: {
      appId: stateContext.appId,
      environment: stateContext.environment,
      branch: stateContext.branch,
      sha: stateContext.sha,
      correlationId: stateContext.correlationId,
      timestamp: new Date().toISOString()
    }
  };
}

module.exports = {
  STATE_CONTEXT_SCHEMA,
  FAIL_CLOSED_TOOLS,
  REQUIRED_STATE_FIELDS,
  StateValidationResult,
  validateStateContext,
  createStateValidationError,
  extractStateContext,
  generateCorrelationId,
  enrichResponseWithState
};
