/**
 * State Context V2: Execution Contract with 10 Required Fields
 *
 * Implements fail-closed, context-complete state validation for all write operations.
 * Required fields: contextVersion, correlationId, stateSessionId, operationId,
 * idempotencyKey, target, source, authorization, runtime, evidence
 */

const crypto = require('node:crypto');

const CONTEXT_VERSION = '2.0.0';

/**
 * 10 Required State Context V2 Fields
 * @typedef {Object} StateContextV2
 * @property {string} contextVersion - Always "2.0.0"
 * @property {string} correlationId - Execution chain UUID (server-generated)
 * @property {string} stateSessionId - Session UUID (for TTL tracking)
 * @property {string} operationId - Operation UUID (idempotency)
 * @property {string} idempotencyKey - Client-provided or derived idempotency key
 * @property {Object} target - Target app/environment
 * @property {string} target.appId - Power Apps appId
 * @property {string} target.environmentId - Power Apps environmentId
 * @property {string} target.displayName - Human-readable display name
 * @property {Object} source - Git source file metadata
 * @property {string} source.provider - "github"
 * @property {string} source.repository - "clean-nano-ai-bridge"
 * @property {string} source.root - "powerapps/CN_AI依頼台帳/Source"
 * @property {string} source.path - Relative file path
 * @property {string} source.branch - Current branch
 * @property {string} source.canonicalBranch - Main branch (canonical)
 * @property {string} source.expectedSha - Expected blob SHA (precheck)
 * @property {string} source.actualSha - Actual blob SHA (verified)
 * @property {string} source.sourceOrigin - Source discovery method (github_canonical, fallback, etc.)
 * @property {Object} authorization - Authorization state
 * @property {string} authorization.state - ready/hold/blocked/expired
 * @property {boolean} authorization.writable - Whether write is allowed
 * @property {boolean} authorization.publishable - Whether publish is allowed
 * @property {boolean} authorization.approvalRequired - Human approval required
 * @property {string} authorization.policyVersion - Policy version
 * @property {Object} runtime - Runtime info
 * @property {string} runtime.version - Bridge version
 * @property {string} runtime.commitSha - Bridge commit SHA
 * @property {string} runtime.instanceId - Instance identifier
 * @property {string} runtime.store - Store adapter name
 * @property {string} runtime.createdAt - ISO timestamp
 * @property {string} runtime.updatedAt - ISO timestamp
 * @property {string} runtime.expiresAt - ISO timestamp (TTL)
 * @property {Object} evidence - Evidence/audit metadata
 * @property {string} evidence.planHash - SHA256 of plan
 * @property {string} evidence.precheckHash - SHA256 of precheck results
 * @property {string} evidence.resultHash - SHA256 of results
 * @property {string} evidence.auditReference - Audit ledger reference
 */

const REQUIRED_FIELDS = [
  'contextVersion',
  'correlationId',
  'stateSessionId',
  'operationId',
  'idempotencyKey',
  'target',
  'source',
  'authorization',
  'runtime',
  'evidence'
];

const REQUIRED_TARGET_FIELDS = ['appId', 'environmentId', 'displayName'];
const REQUIRED_SOURCE_FIELDS = ['provider', 'repository', 'root', 'path', 'branch', 'canonicalBranch', 'expectedSha', 'actualSha', 'sourceOrigin'];
const REQUIRED_AUTHORIZATION_FIELDS = ['state', 'writable', 'publishable', 'approvalRequired', 'policyVersion'];
const REQUIRED_RUNTIME_FIELDS = ['version', 'commitSha', 'instanceId', 'store', 'createdAt', 'updatedAt', 'expiresAt'];
const REQUIRED_EVIDENCE_FIELDS = ['planHash', 'precheckHash', 'resultHash', 'auditReference'];

/**
 * Execution Contract: Full State Context V2 object
 */
class ExecutionContract {
  constructor(context = {}) {
    this.contextVersion = context.contextVersion || CONTEXT_VERSION;
    this.correlationId = context.correlationId || crypto.randomUUID();
    this.stateSessionId = context.stateSessionId || crypto.randomUUID();
    this.operationId = context.operationId || crypto.randomUUID();
    this.idempotencyKey = context.idempotencyKey || `${this.correlationId}`;

    this.target = {
      appId: context.target?.appId || '',
      environmentId: context.target?.environmentId || '',
      displayName: context.target?.displayName || ''
    };

    this.source = {
      provider: context.source?.provider || 'github',
      repository: context.source?.repository || 'clean-nano-ai-bridge',
      root: context.source?.root || 'powerapps/CN_AI依頼台帳/Source',
      path: context.source?.path || '',
      branch: context.source?.branch || '',
      canonicalBranch: context.source?.canonicalBranch || 'main',
      expectedSha: context.source?.expectedSha || '',
      actualSha: context.source?.actualSha || '',
      sourceOrigin: context.source?.sourceOrigin || ''
    };

    this.authorization = {
      state: context.authorization?.state || 'blocked',
      writable: context.authorization?.writable ?? false,
      publishable: context.authorization?.publishable ?? false,
      approvalRequired: context.authorization?.approvalRequired ?? false,
      policyVersion: context.authorization?.policyVersion || '1.0.0'
    };

    this.runtime = {
      version: context.runtime?.version || '0.0.0',
      commitSha: context.runtime?.commitSha || '',
      instanceId: context.runtime?.instanceId || '',
      store: context.runtime?.store || 'memory',
      createdAt: context.runtime?.createdAt || new Date().toISOString(),
      updatedAt: context.runtime?.updatedAt || new Date().toISOString(),
      expiresAt: context.runtime?.expiresAt || new Date(Date.now() + 900000).toISOString()
    };

    this.evidence = {
      planHash: context.evidence?.planHash || '',
      precheckHash: context.evidence?.precheckHash || '',
      resultHash: context.evidence?.resultHash || '',
      auditReference: context.evidence?.auditReference || ''
    };
  }

  /**
   * Validate that all required fields are present and properly typed
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validate() {
    const errors = [];

    // Check top-level required fields
    for (const field of REQUIRED_FIELDS) {
      if (!(field in this)) {
        errors.push(`${field}: missing`);
      }
    }

    // Validate contextVersion
    if (this.contextVersion !== CONTEXT_VERSION) {
      errors.push(`contextVersion: expected "${CONTEXT_VERSION}", got "${this.contextVersion}"`);
    }

    // Validate correlationId format (UUID)
    if (!this._isValidUUID(this.correlationId)) {
      errors.push('correlationId: invalid UUID format');
    }

    // Validate stateSessionId format (UUID)
    if (!this._isValidUUID(this.stateSessionId)) {
      errors.push('stateSessionId: invalid UUID format');
    }

    // Validate operationId format (UUID)
    if (!this._isValidUUID(this.operationId)) {
      errors.push('operationId: invalid UUID format');
    }

    // Validate target
    for (const field of REQUIRED_TARGET_FIELDS) {
      if (!this.target[field] || typeof this.target[field] !== 'string') {
        errors.push(`target.${field}: missing or invalid`);
      }
    }

    // Validate source
    for (const field of REQUIRED_SOURCE_FIELDS) {
      if (!this.source[field] || typeof this.source[field] !== 'string') {
        errors.push(`source.${field}: missing or invalid`);
      }
    }

    // Validate source.actualSha is 40-char hex (Git blob SHA)
    if (!/^[a-f0-9]{40}$/.test(this.source.actualSha)) {
      errors.push('source.actualSha: must be 40-character hex');
    }

    // Validate authorization
    for (const field of REQUIRED_AUTHORIZATION_FIELDS) {
      if (!(field in this.authorization)) {
        errors.push(`authorization.${field}: missing`);
      }
    }

    // Validate authorization state
    const validStates = ['ready', 'hold', 'blocked', 'expired'];
    if (!validStates.includes(this.authorization.state)) {
      errors.push(`authorization.state: must be one of ${validStates.join(', ')}`);
    }

    // Validate authorization.writable is boolean
    if (typeof this.authorization.writable !== 'boolean') {
      errors.push('authorization.writable: must be boolean');
    }

    // Validate authorization.publishable is boolean
    if (typeof this.authorization.publishable !== 'boolean') {
      errors.push('authorization.publishable: must be boolean');
    }

    // Validate authorization.approvalRequired is boolean
    if (typeof this.authorization.approvalRequired !== 'boolean') {
      errors.push('authorization.approvalRequired: must be boolean');
    }

    // Validate runtime
    for (const field of REQUIRED_RUNTIME_FIELDS) {
      if (!(field in this.runtime)) {
        errors.push(`runtime.${field}: missing`);
      }
    }

    // Validate runtime timestamps are ISO format
    for (const field of ['createdAt', 'updatedAt', 'expiresAt']) {
      if (!this._isValidISO(this.runtime[field])) {
        errors.push(`runtime.${field}: invalid ISO 8601 format`);
      }
    }

    // Validate evidence
    for (const field of REQUIRED_EVIDENCE_FIELDS) {
      if (!this.evidence[field] || typeof this.evidence[field] !== 'string') {
        errors.push(`evidence.${field}: missing or invalid`);
      }
    }

    // Validate evidence hashes are hex strings
    for (const field of ['planHash', 'precheckHash', 'resultHash']) {
      if (!/^[a-f0-9]{64}$/.test(this.evidence[field])) {
        errors.push(`evidence.${field}: must be 64-character hex (SHA256)`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Check if write operation is permitted
   * @returns {Object} { allowed: boolean, reason: string }
   */
  canWrite() {
    if (this.authorization.state !== 'ready') {
      return { allowed: false, reason: `state is ${this.authorization.state}, not ready` };
    }
    if (!this.authorization.writable) {
      return { allowed: false, reason: 'authorization.writable is false' };
    }
    if (this.source.branch !== this.source.canonicalBranch) {
      return { allowed: false, reason: `branch "${this.source.branch}" is not canonical "${this.source.canonicalBranch}"` };
    }
    if (this.source.actualSha !== this.source.expectedSha) {
      return { allowed: false, reason: `actualSha "${this.source.actualSha}" does not match expectedSha "${this.source.expectedSha}"` };
    }
    return { allowed: true, reason: 'all conditions met' };
  }

  /**
   * Check if publish operation is permitted
   * @returns {Object} { allowed: boolean, reason: string }
   */
  canPublish() {
    if (!this.canWrite().allowed) {
      return this.canWrite();
    }
    if (!this.authorization.publishable) {
      return { allowed: false, reason: 'authorization.publishable is false' };
    }
    if (this.authorization.approvalRequired) {
      return { allowed: false, reason: 'human approval is required' };
    }
    return { allowed: true, reason: 'all conditions met' };
  }

  /**
   * Mark context as expired
   */
  expire() {
    this.authorization.state = 'expired';
    this.authorization.writable = false;
    this.authorization.publishable = false;
  }

  /**
   * Update runtime metadata
   */
  updateRuntime(updates = {}) {
    this.runtime = {
      ...this.runtime,
      ...updates,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Mark operation as complete with result hash
   */
  completeOperation(resultHash) {
    this.evidence.resultHash = resultHash;
    this.updateRuntime();
  }

  _isValidUUID(str) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  _isValidISO(str) {
    try {
      return !isNaN(Date.parse(str));
    } catch {
      return false;
    }
  }

  /**
   * Serialize to JSON
   */
  toJSON() {
    return {
      contextVersion: this.contextVersion,
      correlationId: this.correlationId,
      stateSessionId: this.stateSessionId,
      operationId: this.operationId,
      idempotencyKey: this.idempotencyKey,
      target: this.target,
      source: this.source,
      authorization: this.authorization,
      runtime: this.runtime,
      evidence: this.evidence
    };
  }
}

module.exports = {
  CONTEXT_VERSION,
  REQUIRED_FIELDS,
  REQUIRED_TARGET_FIELDS,
  REQUIRED_SOURCE_FIELDS,
  REQUIRED_AUTHORIZATION_FIELDS,
  REQUIRED_RUNTIME_FIELDS,
  REQUIRED_EVIDENCE_FIELDS,
  ExecutionContract
};
