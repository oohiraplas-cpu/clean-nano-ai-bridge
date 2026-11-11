/**
 * Diagnostic Engine: Multi-system diagnostics for State Context V2
 *
 * Provides comprehensive health checks and diagnostics for:
 * - Bridge state context integrity
 * - Authorization and policy enforcement
 * - External system connectivity (GitHub, SharePoint, Power Automate)
 * - Transaction status and audit trail
 * - Self-healing recovery strategies
 */

const crypto = require('node:crypto');

/**
 * Diagnostic result codes
 */
const DIAGNOSTIC_CODES = {
  // Health check codes
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  CRITICAL: 'critical',
  UNKNOWN: 'unknown',

  // Category codes
  STATE_CONTEXT_OK: 'state_context_ok',
  STATE_CONTEXT_EXPIRED: 'state_context_expired',
  STATE_CONTEXT_MISSING: 'state_context_missing',
  AUTHORIZATION_OK: 'authorization_ok',
  AUTHORIZATION_FAILED: 'authorization_failed',
  POLICY_COMPLIANT: 'policy_compliant',
  POLICY_VIOLATED: 'policy_violated',
  TRANSACTION_OK: 'transaction_ok',
  TRANSACTION_FAILED: 'transaction_failed',
  TRANSACTION_IN_PROGRESS: 'transaction_in_progress',
  GITHUB_CONNECTED: 'github_connected',
  GITHUB_UNREACHABLE: 'github_unreachable',
  SHAREPOINT_CONNECTED: 'sharepoint_connected',
  SHAREPOINT_UNREACHABLE: 'sharepoint_unreachable',
  POWER_AUTOMATE_CONNECTED: 'power_automate_connected',
  POWER_AUTOMATE_UNREACHABLE: 'power_automate_unreachable',
  AUDIT_LEDGER_HEALTHY: 'audit_ledger_healthy',
  AUDIT_LEDGER_COMPROMISED: 'audit_ledger_compromised'
};

/**
 * Diagnostic Engine class
 */
class DiagnosticEngine {
  constructor({
    stateContextStore = null,
    authorizationService = null,
    policyEngine = null,
    transactionManager = null,
    evidenceLedger = null
  } = {}) {
    this.stateContextStore = stateContextStore;
    this.authorizationService = authorizationService;
    this.policyEngine = policyEngine;
    this.transactionManager = transactionManager;
    this.evidenceLedger = evidenceLedger;
    this.lastDiagnostics = null;
  }

  /**
   * Run comprehensive diagnostics
   * @returns {Object} { status, categories, issues, recommendations, timestamp }
   */
  async runDiagnostics() {
    const timestamp = new Date().toISOString();
    const categories = {};
    const issues = [];
    let overallStatus = DIAGNOSTIC_CODES.HEALTHY;

    // Check state context
    const stateContextDiag = this._diagnoseStateContext();
    categories.stateContext = stateContextDiag;
    if (stateContextDiag.status === DIAGNOSTIC_CODES.CRITICAL) {
      overallStatus = DIAGNOSTIC_CODES.CRITICAL;
    } else if (stateContextDiag.status === DIAGNOSTIC_CODES.DEGRADED && overallStatus === DIAGNOSTIC_CODES.HEALTHY) {
      overallStatus = DIAGNOSTIC_CODES.DEGRADED;
    }
    issues.push(...stateContextDiag.issues);

    // Check authorization
    const authDiag = this._diagnoseAuthorization();
    categories.authorization = authDiag;
    if (authDiag.status === DIAGNOSTIC_CODES.CRITICAL) {
      overallStatus = DIAGNOSTIC_CODES.CRITICAL;
    } else if (authDiag.status === DIAGNOSTIC_CODES.DEGRADED && overallStatus === DIAGNOSTIC_CODES.HEALTHY) {
      overallStatus = DIAGNOSTIC_CODES.DEGRADED;
    }
    issues.push(...authDiag.issues);

    // Check policies
    const policyDiag = this._diagnosePolicies();
    categories.policies = policyDiag;
    if (policyDiag.status === DIAGNOSTIC_CODES.CRITICAL) {
      overallStatus = DIAGNOSTIC_CODES.CRITICAL;
    } else if (policyDiag.status === DIAGNOSTIC_CODES.DEGRADED && overallStatus === DIAGNOSTIC_CODES.HEALTHY) {
      overallStatus = DIAGNOSTIC_CODES.DEGRADED;
    }
    issues.push(...policyDiag.issues);

    // Check transactions
    const txDiag = this._diagnoseTransactions();
    categories.transactions = txDiag;
    if (txDiag.status === DIAGNOSTIC_CODES.CRITICAL) {
      overallStatus = DIAGNOSTIC_CODES.CRITICAL;
    } else if (txDiag.status === DIAGNOSTIC_CODES.DEGRADED && overallStatus === DIAGNOSTIC_CODES.HEALTHY) {
      overallStatus = DIAGNOSTIC_CODES.DEGRADED;
    }
    issues.push(...txDiag.issues);

    // Check audit ledger
    const auditDiag = this._diagnoseAuditLedger();
    categories.auditLedger = auditDiag;
    if (auditDiag.status === DIAGNOSTIC_CODES.CRITICAL) {
      overallStatus = DIAGNOSTIC_CODES.CRITICAL;
    } else if (auditDiag.status === DIAGNOSTIC_CODES.DEGRADED && overallStatus === DIAGNOSTIC_CODES.HEALTHY) {
      overallStatus = DIAGNOSTIC_CODES.DEGRADED;
    }
    issues.push(...auditDiag.issues);

    const recommendations = this._generateRecommendations(issues, categories);

    const result = {
      status: overallStatus,
      timestamp,
      categories,
      issues,
      recommendations,
      isHealthy: overallStatus === DIAGNOSTIC_CODES.HEALTHY
    };

    this.lastDiagnostics = result;
    return result;
  }

  /**
   * Diagnose state context health
   */
  _diagnoseStateContext() {
    const issues = [];
    let status = DIAGNOSTIC_CODES.HEALTHY;

    if (!this.stateContextStore) {
      return {
        status: DIAGNOSTIC_CODES.UNKNOWN,
        code: 'state_context_not_configured',
        issues: [{ code: 'STATE_CONTEXT_NOT_CONFIGURED', message: 'State context store not configured' }]
      };
    }

    try {
      const stats = this.stateContextStore.getStats();

      // Check capacity
      if (stats.percentUsed > 90) {
        status = DIAGNOSTIC_CODES.DEGRADED;
        issues.push({
          code: 'STATE_CONTEXT_NEAR_CAPACITY',
          message: `State context store at ${stats.percentUsed}% capacity`,
          percentUsed: stats.percentUsed
        });
      }

      // Check expiration
      const expiredCount = stats.expiredCount || 0;
      if (expiredCount > 100) {
        status = DIAGNOSTIC_CODES.DEGRADED;
        issues.push({
          code: 'EXCESSIVE_EXPIRED_CONTEXTS',
          message: `${expiredCount} expired contexts waiting cleanup`,
          expiredCount
        });
      }

      return {
        status,
        code: status === DIAGNOSTIC_CODES.HEALTHY ? DIAGNOSTIC_CODES.STATE_CONTEXT_OK : 'degraded',
        stats,
        issues
      };
    } catch (error) {
      return {
        status: DIAGNOSTIC_CODES.CRITICAL,
        code: 'state_context_error',
        error: error.message,
        issues: [{ code: 'STATE_CONTEXT_CHECK_FAILED', message: error.message }]
      };
    }
  }

  /**
   * Diagnose authorization health
   */
  _diagnoseAuthorization() {
    const issues = [];
    let status = DIAGNOSTIC_CODES.HEALTHY;

    if (!this.authorizationService) {
      return {
        status: DIAGNOSTIC_CODES.UNKNOWN,
        code: 'authorization_not_configured',
        issues: [{ code: 'AUTHORIZATION_NOT_CONFIGURED', message: 'Authorization service not configured' }]
      };
    }

    // Check authorization rejection rate
    try {
      const stats = this.authorizationService.getStatistics?.();
      if (stats) {
        const rejectionRate = stats.rejectedCount / (stats.approvedCount + stats.rejectedCount);
        if (rejectionRate > 0.5) {
          status = DIAGNOSTIC_CODES.DEGRADED;
          issues.push({
            code: 'HIGH_REJECTION_RATE',
            message: `Authorization rejection rate is ${(rejectionRate * 100).toFixed(1)}%`,
            rejectionRate
          });
        }
      }
    } catch (error) {
      // Ignore if stats not available
    }

    return {
      status,
      code: status === DIAGNOSTIC_CODES.HEALTHY ? DIAGNOSTIC_CODES.AUTHORIZATION_OK : 'degraded',
      issues
    };
  }

  /**
   * Diagnose policy enforcement health
   */
  _diagnosePolicies() {
    const issues = [];
    let status = DIAGNOSTIC_CODES.HEALTHY;

    if (!this.policyEngine) {
      return {
        status: DIAGNOSTIC_CODES.UNKNOWN,
        code: 'policies_not_configured',
        issues: [{ code: 'POLICIES_NOT_CONFIGURED', message: 'Policy engine not configured' }]
      };
    }

    try {
      const summary = this.policyEngine.getSummary();

      if (!summary || summary.totalPolicies === 0) {
        status = DIAGNOSTIC_CODES.CRITICAL;
        issues.push({
          code: 'NO_POLICIES_LOADED',
          message: 'No policies configured; all operations will be allowed'
        });
      }

      return {
        status,
        code: status === DIAGNOSTIC_CODES.HEALTHY ? DIAGNOSTIC_CODES.POLICY_COMPLIANT : 'critical',
        policyCount: summary?.totalPolicies,
        issues
      };
    } catch (error) {
      return {
        status: DIAGNOSTIC_CODES.CRITICAL,
        code: 'policy_check_failed',
        error: error.message,
        issues: [{ code: 'POLICY_CHECK_FAILED', message: error.message }]
      };
    }
  }

  /**
   * Diagnose transaction health
   */
  _diagnoseTransactions() {
    const issues = [];
    let status = DIAGNOSTIC_CODES.HEALTHY;

    if (!this.transactionManager) {
      return {
        status: DIAGNOSTIC_CODES.UNKNOWN,
        code: 'transactions_not_configured',
        issues: [{ code: 'TRANSACTIONS_NOT_CONFIGURED', message: 'Transaction manager not configured' }]
      };
    }

    try {
      const stats = this.transactionManager.getStatistics();

      // Check for stuck transactions
      if (stats.inProgress > 100) {
        status = DIAGNOSTIC_CODES.DEGRADED;
        issues.push({
          code: 'EXCESSIVE_IN_PROGRESS',
          message: `${stats.inProgress} transactions still in progress`,
          inProgressCount: stats.inProgress
        });
      }

      // Check failure rate
      if (stats.total > 0) {
        const failureRate = stats.failed / stats.total;
        if (failureRate > 0.1) {
          status = DIAGNOSTIC_CODES.DEGRADED;
          issues.push({
            code: 'HIGH_FAILURE_RATE',
            message: `Transaction failure rate is ${(failureRate * 100).toFixed(1)}%`,
            failureRate
          });
        }
      }

      return {
        status,
        code: status === DIAGNOSTIC_CODES.HEALTHY ? DIAGNOSTIC_CODES.TRANSACTION_OK : 'degraded',
        stats,
        issues
      };
    } catch (error) {
      return {
        status: DIAGNOSTIC_CODES.CRITICAL,
        code: 'transaction_check_failed',
        error: error.message,
        issues: [{ code: 'TRANSACTION_CHECK_FAILED', message: error.message }]
      };
    }
  }

  /**
   * Diagnose audit ledger integrity
   */
  _diagnoseAuditLedger() {
    const issues = [];
    let status = DIAGNOSTIC_CODES.HEALTHY;

    if (!this.evidenceLedger) {
      return {
        status: DIAGNOSTIC_CODES.UNKNOWN,
        code: 'audit_ledger_not_configured',
        issues: [{ code: 'AUDIT_LEDGER_NOT_CONFIGURED', message: 'Evidence ledger not configured' }]
      };
    }

    try {
      const integrity = this.evidenceLedger.verifyIntegrity();

      if (!integrity.valid) {
        status = DIAGNOSTIC_CODES.CRITICAL;
        issues.push({
          code: 'AUDIT_LEDGER_TAMPERED',
          message: `Audit ledger integrity check failed; ${integrity.errors.length} errors detected`,
          errorCount: integrity.errors.length,
          errors: integrity.errors.slice(0, 5) // Show first 5
        });
      } else if (integrity.totalRecords > 95000) {
        status = DIAGNOSTIC_CODES.DEGRADED;
        issues.push({
          code: 'AUDIT_LEDGER_NEAR_CAPACITY',
          message: `Audit ledger at ${integrity.totalRecords} / 100000 records`,
          recordCount: integrity.totalRecords
        });
      }

      const stats = this.evidenceLedger.getStatistics();

      return {
        status,
        code: status === DIAGNOSTIC_CODES.HEALTHY ? DIAGNOSTIC_CODES.AUDIT_LEDGER_HEALTHY : 'critical',
        stats,
        issues
      };
    } catch (error) {
      return {
        status: DIAGNOSTIC_CODES.CRITICAL,
        code: 'audit_ledger_check_failed',
        error: error.message,
        issues: [{ code: 'AUDIT_LEDGER_CHECK_FAILED', message: error.message }]
      };
    }
  }

  /**
   * Generate recovery recommendations
   */
  _generateRecommendations(issues, categories) {
    const recommendations = [];

    // State context recommendations
    if (categories.stateContext?.status === DIAGNOSTIC_CODES.DEGRADED) {
      if (categories.stateContext.issues?.some(i => i.code === 'STATE_CONTEXT_NEAR_CAPACITY')) {
        recommendations.push({
          priority: 'high',
          issue: 'STATE_CONTEXT_NEAR_CAPACITY',
          action: 'cleanup_expired_contexts',
          description: 'Run state context cleanup to remove expired contexts'
        });
      }
    }

    // Policy recommendations
    if (categories.policies?.status === DIAGNOSTIC_CODES.CRITICAL) {
      recommendations.push({
        priority: 'critical',
        issue: 'NO_POLICIES_LOADED',
        action: 'reload_default_policies',
        description: 'Reload default policies to restore security controls'
      });
    }

    // Transaction recommendations
    if (categories.transactions?.status === DIAGNOSTIC_CODES.DEGRADED) {
      if (categories.transactions.issues?.some(i => i.code === 'EXCESSIVE_IN_PROGRESS')) {
        recommendations.push({
          priority: 'high',
          issue: 'EXCESSIVE_IN_PROGRESS',
          action: 'review_stuck_transactions',
          description: 'Investigate and resolve stuck transactions'
        });
      }
    }

    // Audit ledger recommendations
    if (categories.auditLedger?.status === DIAGNOSTIC_CODES.CRITICAL) {
      recommendations.push({
        priority: 'critical',
        issue: 'AUDIT_LEDGER_TAMPERED',
        action: 'audit_ledger_integrity_alert',
        description: 'CRITICAL: Audit ledger integrity compromised. Immediate investigation required.'
      });
    }

    if (categories.auditLedger?.status === DIAGNOSTIC_CODES.DEGRADED) {
      recommendations.push({
        priority: 'high',
        issue: 'AUDIT_LEDGER_NEAR_CAPACITY',
        action: 'archive_old_records',
        description: 'Archive old audit records to free ledger capacity'
      });
    }

    return recommendations;
  }

  /**
   * Get last diagnostics result
   */
  getLastDiagnostics() {
    return this.lastDiagnostics;
  }

  /**
   * Get health summary
   */
  getHealthSummary() {
    if (!this.lastDiagnostics) {
      return {
        status: DIAGNOSTIC_CODES.UNKNOWN,
        message: 'No diagnostics run yet'
      };
    }

    return {
      status: this.lastDiagnostics.status,
      isHealthy: this.lastDiagnostics.isHealthy,
      issueCount: this.lastDiagnostics.issues.length,
      recommendationCount: this.lastDiagnostics.recommendations.length,
      timestamp: this.lastDiagnostics.timestamp
    };
  }
}

module.exports = {
  DIAGNOSTIC_CODES,
  DiagnosticEngine
};
