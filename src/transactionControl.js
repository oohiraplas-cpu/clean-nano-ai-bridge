/**
 * Transaction Control: PLAN → PRECHECK → LOCK → EXECUTE → VERIFY → COMMIT → AUDIT
 *
 * Implements transaction lifecycle with rollback support and idempotency.
 */

const crypto = require('node:crypto');

/**
 * Transaction states
 */
const TRANSACTION_STATE = {
  INITIAL: 'initial',
  PLANNED: 'planned',
  PRECHECKED: 'prechecked',
  LOCKED: 'locked',
  EXECUTING: 'executing',
  EXECUTED: 'executed',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  COMMITTING: 'committing',
  COMMITTED: 'committed',
  AUDITING: 'auditing',
  AUDITED: 'audited',
  ABORTING: 'aborting',
  ABORTED: 'aborted',
  ROLLING_BACK: 'rolling_back',
  ROLLED_BACK: 'rolled_back',
  FAILED: 'failed'
};

/**
 * Transaction class
 */
class Transaction {
  constructor({
    transactionId = crypto.randomUUID(),
    operationId,
    operationType = 'save',
    correlationId,
    context = {},
    timeout = 30000
  } = {}) {
    this.transactionId = transactionId;
    this.operationId = operationId;
    this.operationType = operationType;
    this.correlationId = correlationId;
    this.context = context;
    this.timeout = timeout;

    this.state = TRANSACTION_STATE.INITIAL;
    this.startedAt = new Date();
    this.completedAt = null;
    this.duration = 0;

    this.steps = [];
    this.results = {};
    this.errors = [];
    this.rollbackPlan = null;
  }

  /**
   * Step 1: PLAN - Create execution plan
   */
  async plan(planner) {
    this._transition(TRANSACTION_STATE.PLANNED);

    try {
      const plan = await planner({
        operationType: this.operationType,
        context: this.context
      });

      this._recordStep('PLAN', { success: true, planHash: this._hashObject(plan) });
      this.results.plan = plan;
      this.results.planHash = this._hashObject(plan);

      return plan;
    } catch (error) {
      this._recordStep('PLAN', { success: false, error: error.message });
      throw error;
    }
  }

  /**
   * Step 2: PRECHECK - Validate prerequisites
   */
  async precheck(preChecker) {
    this._transition(TRANSACTION_STATE.PRECHECKED);

    try {
      const precheckResults = await preChecker({
        plan: this.results.plan,
        context: this.context
      });

      const precheckHash = this._hashObject(precheckResults);
      this._recordStep('PRECHECK', {
        success: true,
        precheckHash,
        results: precheckResults
      });

      this.results.precheckResults = precheckResults;
      this.results.precheckHash = precheckHash;

      // Check if precheck passed
      if (!precheckResults.valid) {
        throw new Error(`Precheck failed: ${precheckResults.reason}`);
      }

      return precheckResults;
    } catch (error) {
      this._recordStep('PRECHECK', { success: false, error: error.message });
      throw error;
    }
  }

  /**
   * Step 3: LOCK - Acquire lock
   */
  async lock(lockManager) {
    this._transition(TRANSACTION_STATE.LOCKED);

    try {
      const lockResult = await lockManager.acquireLock({
        resource: this.context.target?.appId,
        transactionId: this.transactionId,
        timeout: this.timeout
      });

      if (!lockResult.acquired) {
        throw new Error(`Lock acquisition failed: ${lockResult.reason}`);
      }

      this._recordStep('LOCK', { success: true, lockId: lockResult.lockId });
      this.results.lockId = lockResult.lockId;

      return lockResult;
    } catch (error) {
      this._recordStep('LOCK', { success: false, error: error.message });
      throw error;
    }
  }

  /**
   * Step 4: EXECUTE - Perform the operation
   */
  async execute(executor) {
    this._transition(TRANSACTION_STATE.EXECUTING);

    try {
      const result = await executor({
        plan: this.results.plan,
        context: this.context,
        transactionId: this.transactionId
      });

      this._recordStep('EXECUTE', { success: true });
      this.results.executionResult = result;

      return result;
    } catch (error) {
      this._recordStep('EXECUTE', { success: false, error: error.message });
      throw error;
    }
  }

  /**
   * Step 5: VERIFY - Verify execution results
   */
  async verify(verifier) {
    this._transition(TRANSACTION_STATE.VERIFYING);

    try {
      const verification = await verifier({
        result: this.results.executionResult,
        plan: this.results.plan,
        context: this.context
      });

      if (!verification.valid) {
        throw new Error(`Verification failed: ${verification.reason}`);
      }

      this._recordStep('VERIFY', { success: true, verification });
      this.results.verification = verification;

      return verification;
    } catch (error) {
      this._recordStep('VERIFY', { success: false, error: error.message });
      throw error;
    }
  }

  /**
   * Step 6: COMMIT - Commit the transaction
   */
  async commit(committer) {
    this._transition(TRANSACTION_STATE.COMMITTING);

    try {
      const commitResult = await committer({
        result: this.results.executionResult,
        verification: this.results.verification,
        transactionId: this.transactionId
      });

      this._recordStep('COMMIT', { success: true });
      this.results.commitResult = commitResult;

      this._transition(TRANSACTION_STATE.COMMITTED);
      return commitResult;
    } catch (error) {
      this._recordStep('COMMIT', { success: false, error: error.message });
      throw error;
    }
  }

  /**
   * Step 7: AUDIT - Record in audit ledger
   */
  async audit(auditLogger) {
    this._transition(TRANSACTION_STATE.AUDITING);

    try {
      const auditEntry = {
        transactionId: this.transactionId,
        operationId: this.operationId,
        operationType: this.operationType,
        correlationId: this.correlationId,
        state: this.state,
        startedAt: this.startedAt.toISOString(),
        completedAt: this.completedAt?.toISOString(),
        duration: this.duration,
        steps: this.steps,
        results: this._sanitizeResults(),
        success: this.isSuccessful()
      };

      const auditResult = await auditLogger({
        entry: auditEntry,
        transactionId: this.transactionId
      });

      this._recordStep('AUDIT', { success: true, auditReference: auditResult.reference });
      this.results.auditReference = auditResult.reference;

      this._transition(TRANSACTION_STATE.AUDITED);
      return auditResult;
    } catch (error) {
      this._recordStep('AUDIT', { success: false, error: error.message });
      // Don't throw - audit failure shouldn't fail the transaction
    }
  }

  /**
   * ABORT - Abort transaction and trigger rollback
   */
  async abort(rollbacker) {
    this._transition(TRANSACTION_STATE.ABORTING);

    try {
      const rollbackResult = await rollbacker({
        transactionId: this.transactionId,
        plan: this.rollbackPlan,
        context: this.context
      });

      this._recordStep('ROLLBACK', { success: true, rollbackReference: rollbackResult.reference });
      this._transition(TRANSACTION_STATE.ROLLED_BACK);

      return rollbackResult;
    } catch (error) {
      this._recordStep('ROLLBACK', { success: false, error: error.message });
      this._transition(TRANSACTION_STATE.FAILED);
      throw error;
    }
  }

  /**
   * Check if transaction completed successfully
   */
  isSuccessful() {
    return this.state === TRANSACTION_STATE.AUDITED;
  }

  /**
   * Check if transaction is still in progress
   */
  isInProgress() {
    const inProgressStates = [
      TRANSACTION_STATE.INITIAL,
      TRANSACTION_STATE.PLANNED,
      TRANSACTION_STATE.PRECHECKED,
      TRANSACTION_STATE.LOCKED,
      TRANSACTION_STATE.EXECUTING,
      TRANSACTION_STATE.EXECUTED,
      TRANSACTION_STATE.VERIFYING,
      TRANSACTION_STATE.VERIFIED,
      TRANSACTION_STATE.COMMITTING
    ];
    return inProgressStates.includes(this.state);
  }

  /**
   * Check if transaction has failed
   */
  isFailed() {
    return [TRANSACTION_STATE.FAILED, TRANSACTION_STATE.ROLLED_BACK].includes(this.state);
  }

  /**
   * Record a step in the transaction
   */
  _recordStep(stepName, data = {}) {
    this.steps.push({
      name: stepName,
      timestamp: new Date().toISOString(),
      ...data
    });
  }

  /**
   * Transition to a new state
   */
  _transition(newState) {
    this.state = newState;
  }

  /**
   * Finalize transaction
   */
  _finalize() {
    this.completedAt = new Date();
    this.duration = this.completedAt - this.startedAt;
  }

  /**
   * Sanitize results for audit (remove sensitive data)
   */
  _sanitizeResults() {
    const sanitized = { ...this.results };

    // Remove secrets from execution result
    if (sanitized.executionResult) {
      sanitized.executionResult = this._maskSecrets(sanitized.executionResult);
    }

    return sanitized;
  }

  /**
   * Mask secret values in an object
   */
  _maskSecrets(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;

    const masked = Array.isArray(obj) ? [...obj] : { ...obj };

    for (const key in masked) {
      if (/secret|password|token|key|credential/i.test(key)) {
        masked[key] = '[REDACTED]';
      } else if (typeof masked[key] === 'object') {
        masked[key] = this._maskSecrets(masked[key]);
      }
    }

    return masked;
  }

  /**
   * Hash an object for integrity
   */
  _hashObject(obj) {
    const hashlib = require('node:crypto');
    return hashlib
      .createHash('sha256')
      .update(JSON.stringify(obj || {}))
      .digest('hex');
  }

  /**
   * Serialize to JSON
   */
  toJSON() {
    return {
      transactionId: this.transactionId,
      operationId: this.operationId,
      operationType: this.operationType,
      correlationId: this.correlationId,
      state: this.state,
      startedAt: this.startedAt.toISOString(),
      completedAt: this.completedAt?.toISOString(),
      duration: this.duration,
      steps: this.steps,
      successful: this.isSuccessful(),
      inProgress: this.isInProgress(),
      failed: this.isFailed()
    };
  }
}

/**
 * Transaction Manager
 */
class TransactionManager {
  constructor() {
    this.transactions = new Map();
  }

  /**
   * Create a new transaction
   */
  createTransaction(params = {}) {
    const transaction = new Transaction(params);
    this.transactions.set(transaction.transactionId, transaction);
    return transaction;
  }

  /**
   * Get a transaction by ID
   */
  getTransaction(transactionId) {
    return this.transactions.get(transactionId);
  }

  /**
   * List all transactions
   */
  listTransactions(filter = {}) {
    const results = Array.from(this.transactions.values());

    if (filter.state) {
      return results.filter(t => t.state === filter.state);
    }

    if (filter.operationType) {
      return results.filter(t => t.operationType === filter.operationType);
    }

    return results;
  }

  /**
   * Get statistics
   */
  getStatistics() {
    const transactions = Array.from(this.transactions.values());

    return {
      total: transactions.length,
      successful: transactions.filter(t => t.isSuccessful()).length,
      failed: transactions.filter(t => t.isFailed()).length,
      inProgress: transactions.filter(t => t.isInProgress()).length,
      avgDuration: transactions.length > 0
        ? Math.round(transactions.reduce((sum, t) => sum + t.duration, 0) / transactions.length)
        : 0
    };
  }

  /**
   * Cleanup completed transactions
   */
  cleanup(olderThanMs = 3600000) {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, transaction] of this.transactions) {
      if (transaction.completedAt && (now - transaction.completedAt.getTime()) > olderThanMs) {
        this.transactions.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }
}

module.exports = {
  TRANSACTION_STATE,
  Transaction,
  TransactionManager
};
