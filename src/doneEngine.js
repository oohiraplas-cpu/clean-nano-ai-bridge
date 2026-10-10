/**
 * Phase 7: DONE Engine
 * Automated completion assessment for Power Apps operations
 * 
 * DONE conditions (12 mandatory):
 * 1. State match - Runtime State vs input params complete agreement
 * 2. Branch match - branch === canonicalBranch AND runtime match
 * 3. SHA match - Git SHA === Runtime SHA
 * 4. Save confirmed - Save operation timestamp, status recorded
 * 5. Publish confirmed - Publish operation timestamp, status recorded
 * 6. Re-read confirmed - Post-Save/Publish verification
 * 7. Runtime confirmed - Azure Runtime HTTP 200 OK + response time
 * 8. Authorization confirmed - Target operation permission verified
 * 9. Screen confirmed - Power Apps screen display + Screenshot
 * 10. Evidence captured - CorrelationID + Runtime SHA + Response + State (≥3 items)
 * 11. Audit recorded - Audit log entry
 * 12. Critical errors = 0 - No critical severity errors
 */
const crypto = require('node:crypto');

/**
 * @typedef {Object} DoneCheckResult
 * @property {boolean} done - true if all 12 conditions satisfied
 * @property {string[]} passed - condition keys that passed
 * @property {string[]} failed - condition keys that failed
 * @property {Object} evidence - collected evidence
 * @property {string[]} next - operations still pending
 * @property {string} verdict - "DONE" | "IN_PROGRESS" | "BLOCKED"
 * @property {number} passCount - number of passed conditions
 * @property {number} failCount - number of failed conditions
 */

class DoneEngine {
  constructor(options = {}) {
    this.options = {
      evidenceRetention: options.evidenceRetention || 3600000, // 1 hour
      criticalErrorThreshold: options.criticalErrorThreshold || 0,
      ...options
    };
    this.evidenceCache = new Map();
    this.operations = [
      'state_match',
      'branch_match',
      'sha_match',
      'save_confirmed',
      'publish_confirmed',
      'reread_confirmed',
      'runtime_confirmed',
      'authorization_confirmed',
      'screen_confirmed',
      'evidence_captured',
      'audit_recorded',
      'critical_errors_zero'
    ];
  }

  /**
   * Check condition 1: State match
   * Runtime State vs input parameters complete agreement
   */
  checkStateMatch(inputState, runtimeState) {
    if (!inputState || !runtimeState) return { passed: false, reason: 'missing state' };
    
    const requiredFields = ['appId', 'environment', 'branch', 'canonicalBranch', 'sha'];
    const mismatches = [];
    
    for (const field of requiredFields) {
      if (inputState[field] !== runtimeState[field]) {
        mismatches.push(`${field}: input=${inputState[field]}, runtime=${runtimeState[field]}`);
      }
    }
    
    return {
      passed: mismatches.length === 0,
      mismatches,
      reason: mismatches.length > 0 ? `State mismatch: ${mismatches.join('; ')}` : null
    };
  }

  /**
   * Check condition 2: Branch match
   * branch === canonicalBranch AND runtime consistency
   */
  checkBranchMatch(inputBranch, inputCanonical, runtimeBranch, runtimeCanonical) {
    const inputMatch = inputBranch === inputCanonical;
    const runtimeMatch = runtimeBranch === runtimeCanonical;
    const crossMatch = inputBranch === runtimeBranch && inputCanonical === runtimeCanonical;
    
    return {
      passed: inputMatch && runtimeMatch && crossMatch,
      inputCanonical: inputMatch,
      runtimeCanonical: runtimeMatch,
      crossConsistent: crossMatch,
      reason: !inputMatch ? 'input branch !== canonical' : 
              !runtimeMatch ? 'runtime branch !== canonical' :
              !crossMatch ? 'input/runtime mismatch' : null
    };
  }

  /**
   * Check condition 3: SHA match
   * Git SHA === Runtime SHA (40-char hex format)
   */
  checkShaMatch(inputSha, runtimeSha) {
    const shaRegex = /^[a-f0-9]{40}$/;
    
    if (!shaRegex.test(inputSha) || !shaRegex.test(runtimeSha)) {
      return {
        passed: false,
        inputValid: shaRegex.test(inputSha),
        runtimeValid: shaRegex.test(runtimeSha),
        reason: 'invalid SHA format'
      };
    }
    
    return {
      passed: inputSha === runtimeSha,
      inputShaPrefix: inputSha.substring(0, 8),
      runtimeShaPrefix: runtimeSha.substring(0, 8),
      reason: inputSha !== runtimeSha ? 'SHA mismatch' : null
    };
  }

  /**
   * Check condition 4: Save confirmed
   * Save operation timestamp, status recorded
   */
  checkSaveConfirmed(operationLog) {
    const saveOp = operationLog?.find(op => op.operation === 'save');
    
    if (!saveOp) {
      return { passed: false, reason: 'save operation not found' };
    }
    
    const hasTimestamp = saveOp.timestamp && new Date(saveOp.timestamp).getTime() > 0;
    const hasStatus = saveOp.status && ['success', 'completed', 'ok'].includes(saveOp.status);
    
    return {
      passed: hasTimestamp && hasStatus,
      hasTimestamp,
      hasStatus,
      timestamp: saveOp.timestamp,
      status: saveOp.status,
      reason: !hasTimestamp ? 'missing save timestamp' : !hasStatus ? 'invalid save status' : null
    };
  }

  /**
   * Check condition 5: Publish confirmed
   * Publish operation timestamp, status recorded
   */
  checkPublishConfirmed(operationLog) {
    const publishOp = operationLog?.find(op => op.operation === 'publish');
    
    if (!publishOp) {
      return { passed: false, reason: 'publish operation not found' };
    }
    
    const hasTimestamp = publishOp.timestamp && new Date(publishOp.timestamp).getTime() > 0;
    const hasStatus = publishOp.status && ['success', 'completed', 'ok'].includes(publishOp.status);
    
    return {
      passed: hasTimestamp && hasStatus,
      hasTimestamp,
      hasStatus,
      timestamp: publishOp.timestamp,
      status: publishOp.status,
      reason: !hasTimestamp ? 'missing publish timestamp' : !hasStatus ? 'invalid publish status' : null
    };
  }

  /**
   * Check condition 6: Re-read confirmed
   * Post-Save/Publish verification executed
   */
  checkRereadConfirmed(operationLog, runtimeState) {
    const rereadOps = operationLog?.filter(op => op.operation === 'reread' || op.operation === 'verify');

    if (!rereadOps || rereadOps.length === 0) {
      return { passed: false, reason: 're-read/verify operation not found' };
    }

    const lastReread = rereadOps[rereadOps.length - 1];
    const hasStateSnapshot = lastReread.stateSnapshot && Object.keys(lastReread.stateSnapshot).length > 0;

    // Check if re-read happens after the last publish operation
    const publishOps = operationLog?.filter(op => op.operation === 'publish') || [];
    const lastPublish = publishOps[publishOps.length - 1];
    const isAfterPublish = lastPublish && new Date(lastReread.timestamp) > new Date(lastPublish.timestamp);

    return {
      passed: hasStateSnapshot && isAfterPublish,
      hasStateSnapshot,
      isAfterPublish,
      timestamp: lastReread.timestamp,
      reason: !hasStateSnapshot ? 'missing state snapshot' : !isAfterPublish ? 're-read before publish' : null
    };
  }

  /**
   * Check condition 7: Runtime confirmed
   * Azure Runtime HTTP 200 OK + response time recorded
   */
  checkRuntimeConfirmed(runtimeResponse) {
    if (!runtimeResponse) {
      return { passed: false, reason: 'no runtime response' };
    }
    
    const hasHttpStatus = runtimeResponse.httpStatus === 200;
    const hasResponseTime = runtimeResponse.responseTime > 0 && runtimeResponse.responseTime < 30000; // < 30s
    const hasTimestamp = runtimeResponse.timestamp && new Date(runtimeResponse.timestamp).getTime() > 0;
    
    return {
      passed: hasHttpStatus && hasResponseTime && hasTimestamp,
      httpStatus: runtimeResponse.httpStatus,
      responseTime: runtimeResponse.responseTime,
      timestamp: runtimeResponse.timestamp,
      reason: !hasHttpStatus ? 'HTTP status not 200' : 
              !hasResponseTime ? 'invalid response time' :
              !hasTimestamp ? 'missing timestamp' : null
    };
  }

  /**
   * Check condition 8: Authorization confirmed
   * Target operation permission verified
   */
  checkAuthorizationConfirmed(authContext) {
    if (!authContext) {
      return { passed: false, reason: 'no auth context' };
    }
    
    const hasPermission = authContext.authorized === true;
    const hasScope = authContext.scope && authContext.scope.length > 0;
    const notExpired = authContext.expiresAt && new Date(authContext.expiresAt) > new Date();
    
    return {
      passed: hasPermission && hasScope && notExpired,
      authorized: authContext.authorized,
      scope: authContext.scope,
      expiresAt: authContext.expiresAt,
      reason: !hasPermission ? 'not authorized' : 
              !hasScope ? 'no scope' :
              !notExpired ? 'auth expired' : null
    };
  }

  /**
   * Check condition 9: Screen confirmed
   * Power Apps screen display + Screenshot recorded
   */
  checkScreenConfirmed(screenEvidence) {
    if (!screenEvidence) {
      return { passed: false, reason: 'no screen evidence' };
    }

    const hasScreenshot = screenEvidence.screenshotId && screenEvidence.screenshotId.length > 0;
    const hasDisplayConfirm = screenEvidence.displayConfirmed === true;
    const hasTimestamp = screenEvidence.timestamp && new Date(screenEvidence.timestamp).getTime() > 0;

    return {
      passed: hasScreenshot && hasDisplayConfirm && hasTimestamp,
      hasScreenshot,
      hasDisplayConfirm,
      screenshotId: screenEvidence.screenshotId,
      timestamp: screenEvidence.timestamp,
      reason: !hasScreenshot ? 'missing screenshot' :
              !hasDisplayConfirm ? 'display not confirmed' :
              !hasTimestamp ? 'missing timestamp' : null
    };
  }

  /**
   * Check condition 10: Evidence captured
   * CorrelationID + Runtime SHA + Response + State (≥3 items)
   */
  checkEvidenceCaptured(evidence) {
    if (!evidence) {
      return { passed: false, reason: 'no evidence', count: 0 };
    }
    
    const items = [];
    if (evidence.correlationId) items.push('correlationId');
    if (evidence.runtimeSha) items.push('runtimeSha');
    if (evidence.response) items.push('response');
    if (evidence.state) items.push('state');
    if (evidence.publishResult) items.push('publishResult');
    if (evidence.auditLog) items.push('auditLog');
    
    return {
      passed: items.length >= 3,
      count: items.length,
      items,
      required: 3,
      reason: items.length < 3 ? `insufficient evidence: ${items.length}/3 captured` : null
    };
  }

  /**
   * Check condition 11: Audit recorded
   * Audit log entry exists
   */
  checkAuditRecorded(auditLog) {
    if (!auditLog) {
      return { passed: false, reason: 'no audit log' };
    }

    const hasEntry = Array.isArray(auditLog) && auditLog.length > 0;
    if (!hasEntry) {
      return { passed: false, entryCount: 0, reason: 'no audit entries' };
    }

    const lastEntry = auditLog[auditLog.length - 1];
    const hasTimestamp = !!(lastEntry?.timestamp && new Date(lastEntry.timestamp).getTime() > 0);
    const hasCorrelation = !!(lastEntry?.correlationId && typeof lastEntry.correlationId === 'string' && lastEntry.correlationId.length > 0);

    const passed = !!(hasTimestamp && hasCorrelation);

    return {
      passed,
      entryCount: auditLog.length,
      timestamp: lastEntry?.timestamp,
      correlationId: lastEntry?.correlationId,
      reason: passed ? null : (!hasTimestamp ? 'missing timestamp' : 'missing correlation')
    };
  }

  /**
   * Check condition 12: Critical errors = 0
   * No critical severity errors
   */
  checkCriticalErrorsZero(errorLog) {
    const criticalErrors = errorLog?.filter(err => err.severity === 'critical') || [];
    
    return {
      passed: criticalErrors.length <= this.options.criticalErrorThreshold,
      criticalCount: criticalErrors.length,
      errors: criticalErrors.slice(0, 5), // first 5
      reason: criticalErrors.length > 0 ? `${criticalErrors.length} critical error(s)` : null
    };
  }

  /**
   * Execute full DONE assessment
   */
  assess(context) {
    const {
      inputState,
      runtimeState,
      operationLog,
      runtimeResponse,
      authContext,
      screenEvidence,
      evidence,
      auditLog,
      errorLog
    } = context;
    
    const results = {
      state_match: this.checkStateMatch(inputState, runtimeState),
      branch_match: this.checkBranchMatch(
        inputState?.branch, inputState?.canonicalBranch,
        runtimeState?.branch, runtimeState?.canonicalBranch
      ),
      sha_match: this.checkShaMatch(inputState?.sha, runtimeState?.sha),
      save_confirmed: this.checkSaveConfirmed(operationLog),
      publish_confirmed: this.checkPublishConfirmed(operationLog),
      reread_confirmed: this.checkRereadConfirmed(operationLog, runtimeState),
      runtime_confirmed: this.checkRuntimeConfirmed(runtimeResponse),
      authorization_confirmed: this.checkAuthorizationConfirmed(authContext),
      screen_confirmed: this.checkScreenConfirmed(screenEvidence),
      evidence_captured: this.checkEvidenceCaptured(evidence),
      audit_recorded: this.checkAuditRecorded(auditLog),
      critical_errors_zero: this.checkCriticalErrorsZero(errorLog)
    };
    
    const passed = Object.entries(results).filter(([, result]) => result.passed).map(([key]) => key);
    const failed = Object.entries(results).filter(([, result]) => !result.passed).map(([key]) => key);
    
    const next = failed.filter(key => {
      // Operations that must happen before DONE assessment
      const prerequisites = {
        'save_confirmed': ['runtime_confirmed'],
        'publish_confirmed': ['save_confirmed'],
        'reread_confirmed': ['publish_confirmed'],
        'audit_recorded': ['reread_confirmed']
      };
      const prereqs = prerequisites[key] || [];
      return !prereqs.every(p => passed.includes(p));
    });
    
    const verdict = failed.length === 0 ? 'DONE' : 
                    failed.every(f => !next.includes(f)) ? 'IN_PROGRESS' : 'BLOCKED';
    
    return {
      done: failed.length === 0,
      passed,
      failed,
      results,
      next,
      verdict,
      passCount: passed.length,
      failCount: failed.length,
      completionPercent: Math.round((passed.length / this.operations.length) * 100),
      timestamp: new Date().toISOString(),
      assessmentId: crypto.randomUUID()
    };
  }
}

module.exports = { DoneEngine };
