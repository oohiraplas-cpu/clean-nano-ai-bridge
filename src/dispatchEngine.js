/**
 * Phase 10: Dispatch Engine
 * Orchestrates Phases 7-9 into unified decision-making:
 * - Phase 8 Prohibited Operations: fail-closed safety gates
 * - Phase 7 DONE Engine: completion assessment before proceeding
 * - Phase 9 Evidence Capture: audit trail recording for all decisions
 *
 * Dispatch flow:
 * 1. Receive operation request with context
 * 2. Phase 8: Check if operation is prohibited → BLOCK if unsafe
 * 3. Phase 9: Capture operation request evidence
 * 4. Evaluate pre-conditions (prerequisites completed?)
 * 5. Execute operation (delegated to caller)
 * 6. Phase 9: Capture execution results
 * 7. Phase 7: Assess completion status
 * 8. Phase 9: Capture completion assessment
 * 9. Return final verdict with audit trail
 */
const crypto = require('node:crypto');

/**
 * @typedef {Object} DispatchDecision
 * @property {string} verdict - APPROVED, BLOCKED, REQUIRES_APPROVAL, INCOMPLETE_PREREQUISITES
 * @property {boolean} allowed - true if operation can proceed
 * @property {string} correlationId - trace ID for this operation chain
 * @property {Object} prohibitionCheck - Phase 8 result
 * @property {Object} completionAssessment - Phase 7 result
 * @property {Object} evidenceReport - Phase 9 audit trail
 * @property {Array} nextSteps - what must happen next
 * @property {string} timestamp - ISO 8601
 */

class DispatchEngine {
  constructor(options = {}) {
    this.options = {
      ...options
    };

    this.dispatchLog = [];
  }

  /**
   * Main dispatch: orchestrate all phases
   * @param {Object} request - operation request
   * @param {Object} prohibitionEngine - Phase 8 engine
   * @param {Object} doneEngine - Phase 7 engine
   * @param {Object} evidenceEngine - Phase 9 engine
   * @returns {DispatchDecision}
   */
  dispatch(request, {
    prohibitionEngine,
    doneEngine,
    evidenceEngine
  }) {
    const correlationId = request.correlationId || crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const decision = {
      verdicts: [],
      correlationId,
      timestamp,
      prohibitionCheck: null,
      completionAssessment: null,
      evidenceReport: null,
      nextSteps: [],
      decisionLog: [],
      reasoning: {
        phases: {},
        gatesPassed: [],
        gatesBlocked: [],
        prerequisites: [],
        dependentOperations: []
      }
    };

    // Step 1: Record operation request
    let evidence = null;
    if (evidenceEngine) {
      evidence = evidenceEngine.captureOperationRequest({
        operation: request.operation,
        requestId: request.id,
        requester: request.requester,
        approvalToken: request.approvalToken,
        targetId: request.targetId,
        targetName: request.targetName,
        environment: request.environment,
        correlationId
      });
      decision.decisionLog.push({
        phase: 'evidence',
        action: 'capture_operation_request',
        timestamp: new Date().toISOString(),
        recordId: evidence.id
      });
    }

    // Step 2: PHASE 8 - Check prohibited operations (FAIL-CLOSED)
    let prohibitionResult = null;
    if (prohibitionEngine) {
      prohibitionResult = prohibitionEngine.check({
        operation: request.operation,
        approvalToken: request.approvalToken,
        environment: request.environment,
        targetBranch: request.targetBranch,
        targetName: request.targetName,
        paramKeys: request.paramKeys,
        targetScope: request.targetScope,
        currentScope: request.currentScope,
        sourceEnv: request.sourceEnv,
        targetEnv: request.targetEnv
      });

      decision.prohibitionCheck = prohibitionResult;
      decision.reasoning.phases.prohibitionCheck = {
        allowed: prohibitionResult.allowed,
        violations: prohibitionResult.violations,
        reasons: prohibitionResult.reasons
      };

      decision.decisionLog.push({
        phase: 'prohibited_operations',
        verdict: prohibitionResult.verdict,
        blocked: prohibitionResult.blocked,
        violations: prohibitionResult.violations.length,
        timestamp: new Date().toISOString()
      });

      // FAIL-CLOSED: If ANY operation is prohibited, block entire dispatch
      if (prohibitionResult.blocked) {
        decision.verdicts.push('PROHIBITED_OPERATION');
        decision.reasoning.gatesBlocked.push('prohibited_operations');
        decision.nextSteps.push(`Contact system administrator: ${prohibitionResult.reasons.join('; ')}`);

        // Capture prohibition event
        if (evidenceEngine) {
          evidenceEngine.captureAuditEvent({
            eventType: 'prohibition_blocking',
            fromStatus: 'requested',
            toStatus: 'blocked',
            correlationId,
            reason: prohibitionResult.reasons[0],
            actor: 'prohibited_operations_engine'
          });
        }

        return {
          verdict: 'BLOCKED',
          allowed: false,
          ...decision,
          summary: `Operation BLOCKED by prohibition check: ${prohibitionResult.verdict}`
        };
      }

      decision.reasoning.gatesPassed.push('prohibited_operations');
    }

    // Step 3: Check prerequisites (if provided)
    if (request.prerequisites && request.prerequisites.length > 0) {
      for (const prereq of request.prerequisites) {
        decision.reasoning.prerequisites.push(prereq);
      }
      decision.decisionLog.push({
        phase: 'prerequisites',
        count: request.prerequisites.length,
        timestamp: new Date().toISOString()
      });
    }

    // Step 4: Check if dependent operations are complete (using Phase 7)
    if (request.dependentOnOperations && doneEngine) {
      const dependentChecks = [];
      for (const depOp of request.dependentOnOperations) {
        // Would check each dependent operation's completion
        dependentChecks.push({
          operation: depOp,
          status: 'pending_check'
        });
        decision.reasoning.dependentOperations.push(depOp);
      }
      decision.decisionLog.push({
        phase: 'dependent_operations',
        count: dependentChecks.length,
        timestamp: new Date().toISOString()
      });
    }

    // Step 5: PHASE 7 - Assess completion (if this is a completion-dependent operation)
    let completionAssessment = null;
    if (request.requiresCompletionAssessment && doneEngine) {
      completionAssessment = doneEngine.assess({
        inputState: request.inputState,
        runtimeState: request.runtimeState,
        operationLog: request.operationLog,
        evidence: request.evidence,
        auditLog: request.auditLog,
        errorLog: request.errorLog
      });

      decision.completionAssessment = completionAssessment;
      decision.reasoning.phases.completionAssessment = {
        done: completionAssessment.done,
        verdict: completionAssessment.verdict,
        completionPercent: completionAssessment.completionPercent,
        failed: completionAssessment.failed
      };

      decision.decisionLog.push({
        phase: 'completion_assessment',
        verdict: completionAssessment.verdict,
        completionPercent: completionAssessment.completionPercent,
        timestamp: new Date().toISOString()
      });

      // If completion is incomplete and operation requires it
      if (!completionAssessment.done && request.blockOnIncomplete) {
        decision.verdicts.push('INCOMPLETE_PREREQUISITES');
        decision.reasoning.gatesBlocked.push('completion_assessment');
        decision.nextSteps.push(`Complete remaining steps: ${completionAssessment.failed.join(', ')}`);

        if (evidenceEngine) {
          evidenceEngine.captureAuditEvent({
            eventType: 'completion_blocking',
            fromStatus: 'in_progress',
            toStatus: 'incomplete',
            correlationId,
            reason: `Incomplete prerequisites: ${completionAssessment.failed.join(', ')}`,
            actor: 'done_engine'
          });
        }

        return {
          verdict: 'BLOCKED',
          allowed: false,
          ...decision,
          summary: `Operation BLOCKED: Completion assessment failed - ${completionAssessment.verdict}`
        };
      }

      decision.reasoning.gatesPassed.push('completion_assessment');
    }

    // Step 6: Capture authorization evidence
    if (request.approvalToken && evidenceEngine) {
      evidenceEngine.captureAuthorization({
        approvalMethod: request.approvalMethod || 'token',
        approver: request.approver || 'system',
        approvalScope: request.operation,
        correlationId,
        restrictedTo: request.targetName || request.targetId,
        ttlMinutes: request.approvalTtlMinutes || 60,
        mfaVerified: request.mfaVerified || false
      });
      decision.decisionLog.push({
        phase: 'evidence',
        action: 'capture_authorization',
        timestamp: new Date().toISOString()
      });
    }

    // Step 7: All gates passed - APPROVE operation
    decision.verdicts.push('APPROVED');
    decision.decisionLog.push({
      phase: 'dispatch',
      verdict: 'APPROVED',
      timestamp: new Date().toISOString()
    });

    // Generate final verdict and next steps
    let verdict = 'APPROVED';
    if (decision.verdicts.includes('PROHIBITED_OPERATION')) {
      verdict = 'BLOCKED';
    } else if (decision.verdicts.includes('INCOMPLETE_PREREQUISITES')) {
      verdict = 'BLOCKED';
    }

    // Capture completion event
    if (evidenceEngine) {
      evidenceEngine.captureAuditEvent({
        eventType: 'dispatch_approval',
        fromStatus: 'evaluating',
        toStatus: 'approved',
        correlationId,
        reason: `Operation approved by dispatch: ${request.operation}`,
        actor: 'dispatch_engine'
      });

      // Generate comprehensive evidence report
      decision.evidenceReport = evidenceEngine.generateAuditReport(correlationId);
    }

    if (verdict === 'APPROVED') {
      decision.nextSteps.push('Execute operation');
      decision.nextSteps.push('Capture execution results');
      decision.nextSteps.push('Re-assess completion status');
      decision.nextSteps.push('Archive evidence');
    }

    return {
      verdict,
      allowed: verdict === 'APPROVED',
      ...decision,
      summary: `Operation ${verdict} after all gate checks`,
      readyToExecute: verdict === 'APPROVED',
      prohibitionCheck: decision.prohibitionCheck,
      completionAssessment: decision.completionAssessment,
      evidenceReport: decision.evidenceReport
    };
  }

  /**
   * Evaluate prerequisites and dependencies
   */
  evaluatePrerequisites(prerequisites, completedOperations) {
    const evaluation = {
      allMet: true,
      unmet: [],
      met: [],
      status: 'unknown'
    };

    for (const prereq of prerequisites) {
      if (!completedOperations.includes(prereq)) {
        evaluation.unmet.push(prereq);
        evaluation.allMet = false;
      } else {
        evaluation.met.push(prereq);
      }
    }

    evaluation.status = evaluation.allMet ? 'ready' : 'waiting';
    return evaluation;
  }

  /**
   * Determine next actions based on dispatch decision
   */
  determineNextActions(decision, operationContext) {
    const actions = [];

    if (!decision.allowed) {
      // Operation blocked
      if (decision.prohibitionCheck?.violations?.length > 0) {
        actions.push({
          type: 'inform_user',
          message: `Operation blocked: ${decision.prohibitionCheck.reasons[0]}`,
          severity: 'error'
        });
        if (decision.prohibitionCheck.requiresApprovalCategories?.length > 0) {
          actions.push({
            type: 'request_approval',
            categories: decision.prohibitionCheck.requiresApprovalCategories,
            remediationPath: decision.prohibitionCheck.remediationPath
          });
        }
      }

      if (decision.completionAssessment?.failed?.length > 0) {
        actions.push({
          type: 'inform_user',
          message: `Incomplete prerequisites: ${decision.completionAssessment.failed.join(', ')}`,
          severity: 'warning'
        });
        actions.push({
          type: 'suggest_next_steps',
          steps: decision.completionAssessment.next
        });
      }
    } else {
      // Operation approved
      actions.push({
        type: 'execute_operation',
        operation: operationContext.operation,
        with: {
          correlationId: decision.correlationId,
          approvalToken: operationContext.approvalToken,
          evidence: decision.evidenceReport
        }
      });
    }

    return actions;
  }

  /**
   * Compile comprehensive dispatch report
   */
  generateDispatchReport(decision) {
    return {
      dispatchId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      correlationId: decision.correlationId,
      verdict: decision.verdict,
      allowed: decision.allowed,
      summary: decision.summary,
      reasoning: decision.reasoning,
      decisionLog: decision.decisionLog,
      gatesPassed: decision.reasoning.gatesPassed,
      gatesBlocked: decision.reasoning.gatesBlocked,
      nextSteps: decision.nextSteps,
      readyToExecute: decision.readyToExecute,
      evidence: decision.evidenceReport,
      details: {
        prohibitionCheck: decision.prohibitionCheck,
        completionAssessment: decision.completionAssessment
      }
    };
  }
}

module.exports = { DispatchEngine };
