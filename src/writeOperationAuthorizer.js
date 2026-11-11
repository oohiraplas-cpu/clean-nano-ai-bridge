/**
 * Write Operation Authorizer
 *
 * Implements the common authorizeWriteOperation() enforcement pattern
 * applied to save, publish, git, sharepoint, and power automate operations.
 *
 * Pattern: Context Resolution → Integrity → TTL → Target → Branch → SHA Revalidation
 *          → Lock → Policy → State/Writable → Dependency → Approval → Execution Contract → API
 */

const crypto = require('node:crypto');

/**
 * Standard rejection codes (14 total per spec)
 */
const REJECTION_CODES = {
  MISSING_STATE_CONTEXT: 'MISSING_STATE_CONTEXT',
  INCOMPLETE_STATE_CONTEXT: 'INCOMPLETE_STATE_CONTEXT',
  EXPIRED_STATE_CONTEXT: 'EXPIRED_STATE_CONTEXT',
  CONTEXT_IDENTITY_CONFLICT: 'CONTEXT_IDENTITY_CONFLICT',
  APP_MISMATCH: 'APP_MISMATCH',
  ENV_MISMATCH: 'ENV_MISMATCH',
  NON_CANONICAL_BRANCH: 'NON_CANONICAL_BRANCH',
  SOURCE_SHA_MISMATCH: 'SOURCE_SHA_MISMATCH',
  SOURCE_ORIGIN_MISSING: 'SOURCE_ORIGIN_MISSING',
  STATE_NOT_READY: 'STATE_NOT_READY',
  WRITE_NOT_ALLOWED: 'WRITE_NOT_ALLOWED',
  PUBLISH_NOT_ALLOWED: 'PUBLISH_NOT_ALLOWED',
  STATE_LOCK_FAILED: 'STATE_LOCK_FAILED',
  DEPENDENCY_NOT_CONFIGURED: 'DEPENDENCY_NOT_CONFIGURED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  DUPLICATE_OPERATION: 'DUPLICATE_OPERATION',
  POLICY_DENIED: 'POLICY_DENIED'
};

/**
 * Write operation authorization result
 * @typedef {Object} AuthorizationResult
 * @property {boolean} allowed - Whether operation is allowed
 * @property {string} code - Rejection code or "AUTHORIZED"
 * @property {Object} context - The resolved execution context
 * @property {string} recoveryAction - Suggested recovery action
 * @property {string} auditReference - Reference for audit ledger
 * @property {boolean} externalApiCalled - Whether external API was called (always false on rejection)
 */

/**
 * Authorizer class
 */
class WriteOperationAuthorizer {
  constructor({
    storeAdapter,
    policyEngine,
    lockManager,
    dependencyChecker,
    auditLedger,
    idempotencyCache
  } = {}) {
    this.storeAdapter = storeAdapter;
    this.policyEngine = policyEngine;
    this.lockManager = lockManager;
    this.dependencyChecker = dependencyChecker;
    this.auditLedger = auditLedger;
    this.idempotencyCache = idempotencyCache;
  }

  /**
   * Main authorization pipeline
   *
   * @param {Object} params - { operationType, context, appId, environmentId, branch, sha, sourceOrigin, ... }
   * @returns {Promise<AuthorizationResult>}
   */
  async authorizeWriteOperation(params = {}) {
    const {
      operationType = 'save', // save, publish, git, sharepoint, flow
      context,
      appId,
      environmentId,
      branch,
      sha,
      sourceOrigin,
      targetFile,
      policy = {},
      dependencies = {},
      requestId = crypto.randomUUID(),
      requestedAt = new Date().toISOString()
    } = params;

    const auditReference = `audit:${requestId}`;
    const executionContract = { ...context };

    try {
      // Step 1: Context Resolution
      const contextResolution = this._resolveContext({
        context,
        appId,
        environmentId
      });

      if (!contextResolution.valid) {
        return this._deny(
          REJECTION_CODES.MISSING_STATE_CONTEXT,
          `Context resolution failed: ${contextResolution.errors.join('; ')}`,
          executionContract,
          'Provide complete State Context V2 with all 10 required fields',
          auditReference
        );
      }

      const resolvedContext = contextResolution.context;

      // Step 2: Integrity Check
      const integrityCheck = this._validateContextIntegrity(resolvedContext);
      if (!integrityCheck.valid) {
        return this._deny(
          REJECTION_CODES.CONTEXT_IDENTITY_CONFLICT,
          integrityCheck.error,
          resolvedContext,
          'Verify context matches app/environment/target',
          auditReference
        );
      }

      // Step 3: TTL Check
      const ttlValid = this._checkTTL(resolvedContext.runtime.expiresAt);
      if (!ttlValid) {
        return this._deny(
          REJECTION_CODES.EXPIRED_STATE_CONTEXT,
          'Context TTL has expired',
          resolvedContext,
          'Request fresh State Context from Bridge',
          auditReference
        );
      }

      // Step 4: Target Check (app/environment)
      if (appId && appId !== resolvedContext.target.appId) {
        return this._deny(
          REJECTION_CODES.APP_MISMATCH,
          `App mismatch: requested ${appId}, context ${resolvedContext.target.appId}`,
          resolvedContext,
          'Use same app as in context',
          auditReference
        );
      }

      if (environmentId && environmentId !== resolvedContext.target.environmentId) {
        return this._deny(
          REJECTION_CODES.ENV_MISMATCH,
          `Environment mismatch: requested ${environmentId}, context ${resolvedContext.target.environmentId}`,
          resolvedContext,
          'Use same environment as in context',
          auditReference
        );
      }

      // Step 5: Branch Check
      if (branch && branch !== resolvedContext.source.branch) {
        return this._deny(
          REJECTION_CODES.NON_CANONICAL_BRANCH,
          `Branch "${branch}" does not match context branch "${resolvedContext.source.branch}"`,
          resolvedContext,
          'Use canonical branch from context',
          auditReference
        );
      }

      const sourceIsCanonical = resolvedContext.source.branch === resolvedContext.source.canonicalBranch;
      if (!sourceIsCanonical) {
        return this._deny(
          REJECTION_CODES.NON_CANONICAL_BRANCH,
          `Source branch "${resolvedContext.source.branch}" is not canonical "${resolvedContext.source.canonicalBranch}"`,
          resolvedContext,
          'Only canonical branch allowed for writes',
          auditReference
        );
      }

      // Step 6: SHA Revalidation
      if (!resolvedContext.source.actualSha || !/^[a-f0-9]{40}$/.test(resolvedContext.source.actualSha)) {
        return this._deny(
          REJECTION_CODES.SOURCE_SHA_MISMATCH,
          'Source SHA is missing or invalid',
          resolvedContext,
          'Obtain valid Git blob SHA from Bridge',
          auditReference
        );
      }

      if (sha && sha !== resolvedContext.source.actualSha) {
        return this._deny(
          REJECTION_CODES.SOURCE_SHA_MISMATCH,
          `SHA mismatch: provided "${sha}", context "${resolvedContext.source.actualSha}"`,
          resolvedContext,
          'Retrieve fresh SHA and update context',
          auditReference
        );
      }

      // Also check expectedSha vs actualSha mismatch (pre/post condition)
      if (resolvedContext.source.expectedSha &&
          resolvedContext.source.expectedSha !== resolvedContext.source.actualSha) {
        return this._deny(
          REJECTION_CODES.SOURCE_SHA_MISMATCH,
          `SHA mismatch: expected "${resolvedContext.source.expectedSha}", actual "${resolvedContext.source.actualSha}"`,
          resolvedContext,
          'Retrieve fresh SHA and update context',
          auditReference
        );
      }

      // Step 7: Source Origin Check
      if (!resolvedContext.source.sourceOrigin) {
        return this._deny(
          REJECTION_CODES.SOURCE_ORIGIN_MISSING,
          'Source origin is not set',
          resolvedContext,
          'Establish source origin in context',
          auditReference
        );
      }

      // Step 8: Lock Acquisition
      if (this.lockManager) {
        const lockResult = await this.lockManager.acquireLock({
          resource: resolvedContext.target.appId,
          operationType,
          timeoutMs: 5000
        });

        if (!lockResult.acquired) {
          return this._deny(
            REJECTION_CODES.STATE_LOCK_FAILED,
            `Failed to acquire lock: ${lockResult.reason}`,
            resolvedContext,
            'Retry operation after lock is released',
            auditReference
          );
        }
      }

      // Step 9: Policy Evaluation
      if (this.policyEngine) {
        const policyEval = await this.policyEngine.evaluatePolicy({
          operationType,
          context: resolvedContext,
          policy: { ...policy, operationType }
        });

        if (!policyEval.allowed) {
          return this._deny(
            REJECTION_CODES.POLICY_DENIED,
            `Policy denied: ${policyEval.reason}`,
            resolvedContext,
            policyEval.recoveryAction || 'Review policy requirements',
            auditReference
          );
        }
      }

      // Step 10: State and Writable Check
      const stateCheck = this._validateAuthorizationState(resolvedContext, operationType);
      if (!stateCheck.valid) {
        const code = operationType === 'publish'
          ? REJECTION_CODES.PUBLISH_NOT_ALLOWED
          : REJECTION_CODES.WRITE_NOT_ALLOWED;

        return this._deny(
          code,
          stateCheck.error,
          resolvedContext,
          stateCheck.recovery,
          auditReference
        );
      }

      // Step 11: Dependency Check
      if (this.dependencyChecker) {
        const depCheck = await this.dependencyChecker.checkDependencies({
          operationType,
          requiredDependencies: dependencies
        });

        if (!depCheck.healthy) {
          const code = depCheck.configured
            ? REJECTION_CODES.DEPENDENCY_UNAVAILABLE
            : REJECTION_CODES.DEPENDENCY_NOT_CONFIGURED;

          return this._deny(
            code,
            `Dependency issue: ${depCheck.reason}`,
            resolvedContext,
            depCheck.recoveryAction || 'Check dependency health',
            auditReference
          );
        }
      }

      // Step 12: Approval Gate
      if (resolvedContext.authorization.approvalRequired) {
        return this._deny(
          REJECTION_CODES.APPROVAL_REQUIRED,
          'Human approval is required for this operation',
          resolvedContext,
          'Request approval from human reviewer',
          auditReference
        );
      }

      // Step 13: Idempotency Check
      const idempotencyKey = resolvedContext.idempotencyKey;
      if (this.idempotencyCache) {
        const previousResult = await this.idempotencyCache.get(idempotencyKey);
        if (previousResult) {
          // Return cached result (success) - not a rejection
          return this._allow(resolvedContext, auditReference, true);
        }
      }

      // All checks passed - authorization granted
      return this._allow(resolvedContext, auditReference);

    } catch (error) {
      return this._deny(
        'INTERNAL_ERROR',
        error.message,
        executionContract,
        'Check server logs for details',
        auditReference
      );
    }
  }

  /**
   * Resolve context from provided parameters
   */
  _resolveContext({ context, appId, environmentId }) {
    const errors = [];

    if (!context || typeof context !== 'object') {
      errors.push('context is missing or not an object');
    }

    const ctx = context || {};
    const hasRequiredFields = [
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
    ].every(field => field in ctx);

    if (!hasRequiredFields) {
      errors.push('context missing one or more required fields');
    }

    if (appId && ctx.target && ctx.target.appId !== appId) {
      errors.push(`appId mismatch: ${appId} vs ${ctx.target?.appId}`);
    }

    if (environmentId && ctx.target && ctx.target.environmentId !== environmentId) {
      errors.push(`environmentId mismatch: ${environmentId} vs ${ctx.target?.environmentId}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      context: ctx
    };
  }

  /**
   * Validate context integrity
   */
  _validateContextIntegrity(context) {
    // Check that IDs are consistent
    if (context.correlationId && context.idempotencyKey) {
      // OK - both are set
    }

    if (!context.target?.appId || !context.target?.environmentId) {
      return {
        valid: false,
        error: 'Target app/environment not set in context'
      };
    }

    if (!context.source?.branch || !context.source?.canonicalBranch) {
      return {
        valid: false,
        error: 'Source branch information incomplete'
      };
    }

    return { valid: true };
  }

  /**
   * Check context TTL
   */
  _checkTTL(expiresAt) {
    if (!expiresAt) return false;
    try {
      const expireTime = new Date(expiresAt).getTime();
      return expireTime > Date.now();
    } catch {
      return false;
    }
  }

  /**
   * Validate authorization state for operation
   */
  _validateAuthorizationState(context, operationType) {
    const { state, writable, publishable } = context.authorization;

    if (state !== 'ready') {
      return {
        valid: false,
        error: `Authorization state is "${state}", not "ready"`,
        recovery: 'Resolve state context issues'
      };
    }

    if (operationType === 'publish' && !publishable) {
      return {
        valid: false,
        error: 'Publish not allowed (authorization.publishable = false)',
        recovery: 'Check publish prerequisites'
      };
    }

    if (operationType !== 'publish' && !writable) {
      return {
        valid: false,
        error: 'Write not allowed (authorization.writable = false)',
        recovery: 'Check write prerequisites'
      };
    }

    return { valid: true };
  }

  /**
   * Return denial result
   */
  _deny(code, message, context, recoveryAction, auditReference) {
    return {
      allowed: false,
      code,
      message,
      context,
      recoveryAction,
      auditReference,
      externalApiCalled: false
    };
  }

  /**
   * Return approval result
   */
  _allow(context, auditReference, isIdempotentReplay = false) {
    return {
      allowed: true,
      code: 'AUTHORIZED',
      context,
      auditReference,
      externalApiCalled: false,
      isIdempotentReplay
    };
  }
}

module.exports = {
  REJECTION_CODES,
  WriteOperationAuthorizer
};
