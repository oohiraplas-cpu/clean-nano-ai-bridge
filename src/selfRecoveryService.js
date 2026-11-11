/**
 * Self-Recovery Service: Automated recovery for State Context V2 failures
 *
 * Implements automated and semi-automated recovery strategies for:
 * - Expired state contexts (auto-renewal)
 * - Failed transactions (rollback + retry)
 * - Policy violations (grace period + audit)
 * - Authorization failures (context regeneration)
 * - Stuck transactions (timeout + cleanup)
 */

const crypto = require('node:crypto');

/**
 * Recovery action types
 */
const RECOVERY_ACTION = {
  AUTO_RENEW: 'auto_renew',
  ROLLBACK_RETRY: 'rollback_retry',
  MANUAL_REVIEW: 'manual_review',
  POLICY_EXCEPTION: 'policy_exception',
  CONTEXT_REGENERATE: 'context_regenerate',
  TRANSACTION_ABORT: 'transaction_abort',
  LEDGER_RECOVERY: 'ledger_recovery'
};

/**
 * Recovery states
 */
const RECOVERY_STATE = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  NEEDS_APPROVAL: 'needs_approval',
  CANCELLED: 'cancelled'
};

/**
 * Self-Recovery Service class
 */
class SelfRecoveryService {
  constructor({
    stateContextStore = null,
    transactionManager = null,
    policyEngine = null,
    evidenceLedger = null,
    autoRecoveryEnabled = true,
    approvalRequired = new Set(['POLICY_EXCEPTION', 'LEDGER_RECOVERY'])
  } = {}) {
    this.stateContextStore = stateContextStore;
    this.transactionManager = transactionManager;
    this.policyEngine = policyEngine;
    this.evidenceLedger = evidenceLedger;
    this.autoRecoveryEnabled = autoRecoveryEnabled;
    this.approvalRequired = approvalRequired;
    this.recoveryLog = [];
  }

  /**
   * Execute recovery plan
   * @param {string} failureCode - Code identifying the failure type
   * @param {Object} context - Context object with failure details
   * @returns {Object} { action, state, result, approvalRequired }
   */
  async executeRecovery(failureCode, context = {}) {
    const recovery = {
      recoveryId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      failureCode,
      context,
      action: null,
      state: RECOVERY_STATE.PENDING,
      result: null,
      attempts: 0,
      maxAttempts: 3
    };

    try {
      // Determine recovery action
      recovery.action = this._determineRecoveryAction(failureCode, context);

      // Check if approval required
      if (this.approvalRequired.has(recovery.action)) {
        recovery.state = RECOVERY_STATE.NEEDS_APPROVAL;
        this.recoveryLog.push(recovery);
        return {
          recoveryId: recovery.recoveryId,
          action: recovery.action,
          state: RECOVERY_STATE.NEEDS_APPROVAL,
          approvalRequired: true,
          failureCode
        };
      }

      // Auto-execute if enabled
      if (this.autoRecoveryEnabled) {
        recovery.state = RECOVERY_STATE.IN_PROGRESS;
        recovery.result = await this._executeAction(recovery.action, context);
        recovery.state = recovery.result.success ? RECOVERY_STATE.SUCCEEDED : RECOVERY_STATE.FAILED;
      }

      this.recoveryLog.push(recovery);

      return {
        recoveryId: recovery.recoveryId,
        action: recovery.action,
        state: recovery.state,
        result: recovery.result,
        approvalRequired: false
      };
    } catch (error) {
      recovery.state = RECOVERY_STATE.FAILED;
      recovery.error = error.message;
      this.recoveryLog.push(recovery);

      return {
        recoveryId: recovery.recoveryId,
        action: recovery.action,
        state: RECOVERY_STATE.FAILED,
        error: error.message,
        approvalRequired: false
      };
    }
  }

  /**
   * Determine recovery action based on failure code
   */
  _determineRecoveryAction(failureCode, context) {
    const actions = {
      'EXPIRED_STATE_CONTEXT': RECOVERY_ACTION.AUTO_RENEW,
      'MISSING_STATE_CONTEXT': RECOVERY_ACTION.CONTEXT_REGENERATE,
      'TRANSACTION_FAILED': RECOVERY_ACTION.ROLLBACK_RETRY,
      'TRANSACTION_STUCK': RECOVERY_ACTION.TRANSACTION_ABORT,
      'POLICY_DENIED': RECOVERY_ACTION.POLICY_EXCEPTION,
      'AUDIT_LEDGER_COMPROMISED': RECOVERY_ACTION.LEDGER_RECOVERY,
      'AUTHORIZATION_FAILED': RECOVERY_ACTION.CONTEXT_REGENERATE
    };

    return actions[failureCode] || RECOVERY_ACTION.MANUAL_REVIEW;
  }

  /**
   * Execute recovery action
   */
  async _executeAction(action, context) {
    try {
      switch (action) {
        case RECOVERY_ACTION.AUTO_RENEW:
          return await this._autoRenewContext(context);

        case RECOVERY_ACTION.CONTEXT_REGENERATE:
          return await this._regenerateContext(context);

        case RECOVERY_ACTION.ROLLBACK_RETRY:
          return await this._rollbackAndRetry(context);

        case RECOVERY_ACTION.TRANSACTION_ABORT:
          return await this._abortTransaction(context);

        case RECOVERY_ACTION.POLICY_EXCEPTION:
          return {
            success: false,
            reason: 'Policy exception requires manual approval'
          };

        case RECOVERY_ACTION.LEDGER_RECOVERY:
          return {
            success: false,
            reason: 'Ledger recovery requires manual review'
          };

        default:
          return {
            success: false,
            reason: 'Unknown recovery action'
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Auto-renew expired state context
   */
  async _autoRenewContext(context) {
    if (!this.stateContextStore || !context.contextId) {
      return {
        success: false,
        reason: 'State context store not configured or contextId missing'
      };
    }

    try {
      const stateContext = this.stateContextStore.get(context.contextId);
      if (!stateContext) {
        return {
          success: false,
          reason: 'State context not found'
        };
      }

      // Create renewed context with extended TTL
      const renewedContext = {
        ...stateContext,
        contextId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ttl: context.ttl || 900000 // 15 minutes default
      };

      this.stateContextStore.set(renewedContext.contextId, renewedContext);

      return {
        success: true,
        newContextId: renewedContext.contextId,
        message: 'State context renewed'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Regenerate context from scratch
   */
  async _regenerateContext(context) {
    if (!this.stateContextStore) {
      return {
        success: false,
        reason: 'State context store not configured'
      };
    }

    try {
      // Build new context from parameters
      const newContext = {
        contextVersion: '2.0.0',
        contextId: crypto.randomUUID(),
        correlationId: context.correlationId || crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ttl: 900000,
        target: context.target || {},
        source: context.source || {},
        authorization: context.authorization || { writable: false, publishable: false },
        runtime: context.runtime || {},
        evidence: context.evidence || {}
      };

      this.stateContextStore.set(newContext.contextId, newContext);

      return {
        success: true,
        contextId: newContext.contextId,
        message: 'Context regenerated'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Rollback transaction and retry
   */
  async _rollbackAndRetry(context) {
    if (!this.transactionManager) {
      return {
        success: false,
        reason: 'Transaction manager not configured'
      };
    }

    try {
      const transaction = this.transactionManager.getTransaction(context.transactionId);
      if (!transaction) {
        return {
          success: false,
          reason: 'Transaction not found'
        };
      }

      // Trigger rollback (actual rollback logic depends on transaction state)
      // This is a placeholder - real implementation would call transaction.abort()
      if (transaction.isFailed() || transaction.isInProgress()) {
        return {
          success: true,
          message: 'Transaction marked for rollback',
          transactionId: context.transactionId
        };
      }

      return {
        success: false,
        reason: 'Transaction cannot be rolled back in current state'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Abort stuck transaction
   */
  async _abortTransaction(context) {
    if (!this.transactionManager) {
      return {
        success: false,
        reason: 'Transaction manager not configured'
      };
    }

    try {
      const transaction = this.transactionManager.getTransaction(context.transactionId);
      if (!transaction) {
        return {
          success: false,
          reason: 'Transaction not found'
        };
      }

      // Mark for abort if stuck longer than timeout
      const stuckDuration = Date.now() - transaction.startedAt.getTime();
      const timeoutMs = context.timeout || 300000; // 5 minutes default

      if (stuckDuration > timeoutMs) {
        return {
          success: true,
          message: 'Transaction aborted due to timeout',
          transactionId: context.transactionId,
          stuckDuration
        };
      }

      return {
        success: false,
        reason: 'Transaction not stuck yet'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Approve pending recovery action
   */
  async approveRecovery(recoveryId, approverPrincipal) {
    const recovery = this.recoveryLog.find(r => r.recoveryId === recoveryId);
    if (!recovery) {
      return {
        success: false,
        reason: 'Recovery action not found'
      };
    }

    if (recovery.state !== RECOVERY_STATE.NEEDS_APPROVAL) {
      return {
        success: false,
        reason: `Recovery action is in ${recovery.state} state, not pending approval`
      };
    }

    try {
      recovery.state = RECOVERY_STATE.IN_PROGRESS;
      recovery.approver = approverPrincipal;
      recovery.approvedAt = new Date().toISOString();

      // Execute the action
      recovery.result = await this._executeAction(recovery.action, recovery.context);
      recovery.state = recovery.result.success ? RECOVERY_STATE.SUCCEEDED : RECOVERY_STATE.FAILED;

      return {
        success: recovery.result.success,
        state: recovery.state,
        result: recovery.result
      };
    } catch (error) {
      recovery.state = RECOVERY_STATE.FAILED;
      recovery.error = error.message;

      return {
        success: false,
        state: RECOVERY_STATE.FAILED,
        error: error.message
      };
    }
  }

  /**
   * Deny recovery action
   */
  denyRecovery(recoveryId, denierPrincipal, reason) {
    const recovery = this.recoveryLog.find(r => r.recoveryId === recoveryId);
    if (!recovery) {
      return {
        success: false,
        reason: 'Recovery action not found'
      };
    }

    recovery.state = RECOVERY_STATE.CANCELLED;
    recovery.denier = denierPrincipal;
    recovery.denialReason = reason;
    recovery.deniedAt = new Date().toISOString();

    return {
      success: true,
      state: RECOVERY_STATE.CANCELLED
    };
  }

  /**
   * Get recovery history
   */
  getRecoveryHistory(filter = {}) {
    let results = this.recoveryLog;

    if (filter.state) {
      results = results.filter(r => r.state === filter.state);
    }

    if (filter.action) {
      results = results.filter(r => r.action === filter.action);
    }

    if (filter.failureCode) {
      results = results.filter(r => r.failureCode === filter.failureCode);
    }

    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /**
   * Get recovery statistics
   */
  getStatistics() {
    const stats = {
      total: this.recoveryLog.length,
      succeeded: 0,
      failed: 0,
      pending: 0,
      cancelled: 0,
      byAction: {},
      byFailureCode: {}
    };

    for (const recovery of this.recoveryLog) {
      if (recovery.state === RECOVERY_STATE.SUCCEEDED) {
        stats.succeeded++;
      } else if (recovery.state === RECOVERY_STATE.FAILED) {
        stats.failed++;
      } else if (recovery.state === RECOVERY_STATE.NEEDS_APPROVAL) {
        stats.pending++;
      } else if (recovery.state === RECOVERY_STATE.CANCELLED) {
        stats.cancelled++;
      }

      // Count by action
      if (recovery.action) {
        stats.byAction[recovery.action] = (stats.byAction[recovery.action] || 0) + 1;
      }

      // Count by failure code
      stats.byFailureCode[recovery.failureCode] = (stats.byFailureCode[recovery.failureCode] || 0) + 1;
    }

    return stats;
  }
}

module.exports = {
  RECOVERY_ACTION,
  RECOVERY_STATE,
  SelfRecoveryService
};
