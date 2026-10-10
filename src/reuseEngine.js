/**
 * Phase 11: Reuse Engine
 * Learns from past operations and generates reusable patterns
 *
 * Pattern detection:
 * 1. Operation Signature - unique fingerprint of operation sequence
 * 2. Success Pattern - proven sequence of steps that succeeded
 * 3. Failure Pattern - known failure cases to avoid
 * 4. Template - standardized operation with variable placeholders
 * 5. Playbook - pre-approved sequence for recurring scenarios
 * 6. Shortcut - optimized path for known good patterns
 * 7. Risk Profile - historical risk assessment for similar ops
 * 8. Remediation Pattern - proven recovery sequences
 * 9. Checkpoint - verified intermediate states
 * 10. Optimization Hint - performance recommendations
 */
const crypto = require('node:crypto');

/**
 * @typedef {Object} Pattern
 * @property {string} id - unique pattern ID
 * @property {string} signature - fingerprint of operation sequence
 * @property {string} category - pattern type
 * @property {number} successCount - how many times succeeded
 * @property {number} failureCount - how many times failed
 * @property {number} successRate - percentage success rate
 * @property {*} template - reusable template
 * @property {string} createdAt - when pattern was discovered
 * @property {string} lastUsedAt - when last applied
 * @property {number} usageCount - total usage count
 */

class ReuseEngine {
  constructor(options = {}) {
    this.options = {
      minSuccessCountForPattern: options.minSuccessCountForPattern || 3,
      minSuccessRateForTemplate: options.minSuccessRateForTemplate || 0.8,
      patternRetentionDays: options.patternRetentionDays || 365,
      ...options
    };

    this.patterns = [];
    this.successHistory = [];
    this.failureHistory = [];
  }

  /**
   * Learn from a successful operation
   */
  recordSuccess(context) {
    const {
      operation,
      operationId,
      steps,
      targetId,
      environment,
      executionTime,
      approvalRequired,
      correlationId
    } = context;

    const signature = this.generateSignature({
      operation,
      targetId,
      environment,
      stepCount: steps?.length || 0
    });

    const record = {
      id: crypto.randomUUID(),
      operationId,
      signature,
      operation,
      targetId,
      environment,
      steps: steps || [],
      executionTime,
      approvalRequired,
      correlationId,
      timestamp: new Date().toISOString(),
      status: 'success'
    };

    this.successHistory.push(record);
    this.updateOrCreatePattern(signature, true, context);
    return record;
  }

  /**
   * Learn from a failed operation
   */
  recordFailure(context) {
    const {
      operation,
      operationId,
      steps,
      targetId,
      environment,
      errorReason,
      failurePoint,
      correlationId
    } = context;

    const signature = this.generateSignature({
      operation,
      targetId,
      environment,
      stepCount: steps?.length || 0
    });

    const record = {
      id: crypto.randomUUID(),
      operationId,
      signature,
      operation,
      targetId,
      environment,
      steps: steps || [],
      errorReason,
      failurePoint,
      correlationId,
      timestamp: new Date().toISOString(),
      status: 'failure'
    };

    this.failureHistory.push(record);
    this.updateOrCreatePattern(signature, false, context);
    return record;
  }

  /**
   * Generate operation signature (fingerprint)
   */
  generateSignature(context) {
    const data = JSON.stringify({
      operation: context.operation,
      targetId: context.targetId,
      environment: context.environment,
      stepCount: context.stepCount
    });

    return crypto
      .createHash('sha256')
      .update(data)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Update or create pattern based on operation result
   */
  updateOrCreatePattern(signature, success, context) {
    let pattern = this.patterns.find(p => p.signature === signature);

    if (!pattern) {
      pattern = {
        id: crypto.randomUUID(),
        signature,
        category: this.categorizePattern(context),
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        template: this.generateTemplate(context),
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        usageCount: 0,
        observations: []
      };
      this.patterns.push(pattern);
    }

    if (success) {
      pattern.successCount++;
    } else {
      pattern.failureCount++;
    }

    pattern.usageCount = pattern.successCount + pattern.failureCount;
    pattern.successRate = pattern.successCount / pattern.usageCount;
    pattern.lastUsedAt = new Date().toISOString();

    // Record observation
    pattern.observations.push({
      timestamp: new Date().toISOString(),
      success,
      context: {
        operation: context.operation,
        targetId: context.targetId,
        environment: context.environment
      }
    });

    return pattern;
  }

  /**
   * Categorize pattern by operation characteristics
   */
  categorizePattern(context) {
    const operation = context.operation || '';

    if (operation.includes('publish') || operation.includes('deploy')) {
      return 'deployment';
    } else if (operation.includes('delete') || operation.includes('remove')) {
      return 'deletion';
    } else if (operation.includes('save') || operation.includes('update')) {
      return 'modification';
    } else if (operation.includes('rollback') || operation.includes('recovery')) {
      return 'remediation';
    } else if (operation.includes('verify') || operation.includes('validate')) {
      return 'validation';
    }
    return 'general';
  }

  /**
   * Generate reusable template from successful operation
   */
  generateTemplate(context) {
    const { operation, steps, targetId, environment, approvalRequired } = context;

    return {
      name: `${operation}_template`,
      operation,
      description: `Template for ${operation} in ${environment}`,
      steps: (steps || []).map((step, idx) => ({
        order: idx + 1,
        action: step.action,
        parameters: step.parameters || {},
        expected: step.expected,
        optional: step.optional || false
      })),
      targetIdPattern: this.inferPattern(targetId),
      environment,
      approvalRequired,
      variables: this.extractVariables(steps || []),
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Infer target ID pattern from examples
   */
  inferPattern(targetId) {
    if (!targetId) return null;

    const prefixMatch = targetId.match(/^([a-z_]+)-/);
    const prefix = prefixMatch ? prefixMatch[1] : null;

    return {
      prefix,
      example: targetId,
      pattern: prefix ? `${prefix}-*` : '*'
    };
  }

  /**
   * Extract variable placeholders from operation steps
   */
  extractVariables(steps) {
    const variables = new Set();

    for (const step of steps) {
      const paramsStr = JSON.stringify(step.parameters || {});
      const matches = paramsStr.match(/\$\{(\w+)\}/g) || [];
      matches.forEach(m => variables.add(m));
    }

    return Array.from(variables);
  }

  /**
   * Suggest pattern match for new operation
   */
  suggestPattern(context) {
    const signature = this.generateSignature({
      operation: context.operation,
      targetId: context.targetId,
      environment: context.environment,
      stepCount: context.steps?.length || 0
    });

    let exactMatch = this.patterns.find(p => p.signature === signature);
    if (exactMatch && exactMatch.successRate >= this.options.minSuccessRateForTemplate) {
      return {
        matchType: 'exact',
        pattern: exactMatch,
        confidence: exactMatch.successRate,
        recommendation: 'Use proven template'
      };
    }

    // Find similar patterns by operation and environment
    const similarPatterns = this.patterns
      .filter(p => {
        const obs = p.observations?.[0]?.context || {};
        return obs.operation === context.operation &&
               obs.environment === context.environment &&
               p.successRate >= this.options.minSuccessRateForTemplate;
      })
      .sort((a, b) => b.successRate - a.successRate);

    if (similarPatterns.length > 0) {
      return {
        matchType: 'similar',
        patterns: similarPatterns.slice(0, 3),
        confidence: similarPatterns[0].successRate,
        recommendation: 'Similar pattern available, adapt template'
      };
    }

    // Check for risk patterns (failures)
    const riskPatterns = this.patterns.filter(p => {
      const obs = p.observations?.[0]?.context || {};
      return obs.operation === context.operation &&
             obs.environment === context.environment &&
             p.failureCount > 0;
    });

    if (riskPatterns.length > 0) {
      return {
        matchType: 'risk',
        patterns: riskPatterns,
        confidence: 1 - riskPatterns[0].successRate,
        recommendation: 'Similar operation failed before - review risks'
      };
    }

    return {
      matchType: 'none',
      confidence: 0,
      recommendation: 'No pattern match - proceed with caution'
    };
  }

  /**
   * Get playbook for operation
   */
  getPlaybook(operation, environment) {
    const patterns = this.patterns.filter(p => {
      const obs = p.observations?.[0]?.context || {};
      return obs.operation === operation &&
             obs.environment === environment &&
             p.successCount >= this.options.minSuccessCountForPattern;
    });

    if (patterns.length === 0) {
      return null;
    }

    const bestPattern = patterns.reduce((best, p) =>
      p.successRate > best.successRate ? p : best
    );

    return {
      playbookId: crypto.randomUUID(),
      operation,
      environment,
      successHistory: bestPattern.successCount,
      failureHistory: bestPattern.failureCount,
      successRate: bestPattern.successRate,
      template: bestPattern.template,
      riskFactors: this.identifyRiskFactors(bestPattern),
      checkpoints: this.identifyCheckpoints(bestPattern),
      estimatedDuration: this.estimateDuration(bestPattern),
      prerequisitesByFrequency: this.analyzePrerequisites(bestPattern)
    };
  }

  /**
   * Identify risk factors from pattern history
   */
  identifyRiskFactors(pattern) {
    if (pattern.failureCount === 0) {
      return [];
    }

    const failureReasons = new Map();
    const relevantFailures = this.failureHistory.filter(f =>
      pattern.observations?.some(obs =>
        obs.success === false &&
        obs.context.operation === f.operation
      )
    );

    for (const failure of relevantFailures) {
      const reason = failure.errorReason || 'unknown';
      failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
    }

    return Array.from(failureReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({
        reason,
        frequency: count,
        mitigation: this.suggestMitigation(reason)
      }));
  }

  /**
   * Suggest mitigation for known failures
   */
  suggestMitigation(failureReason) {
    const mitigations = {
      'network_timeout': 'Implement retry logic with exponential backoff',
      'permission_denied': 'Verify approval token and authorization scope',
      'state_mismatch': 'Re-fetch latest state before operation',
      'sha_mismatch': 'Confirm branch is canonical, pull latest changes',
      'locked_resource': 'Wait for existing operation to complete',
      'validation_failed': 'Review input parameters against schema',
      'external_api_error': 'Check third-party service status'
    };

    return mitigations[failureReason] || 'Manual review required';
  }

  /**
   * Identify checkpoints (verified intermediate states)
   */
  identifyCheckpoints(pattern) {
    const checkpoints = [];

    if (pattern.template?.steps) {
      const stepCount = pattern.template.steps.length;
      const checkpointIndices = [
        Math.floor(stepCount * 0.25),
        Math.floor(stepCount * 0.5),
        Math.floor(stepCount * 0.75)
      ];

      for (const idx of checkpointIndices) {
        if (idx > 0 && idx < stepCount) {
          const step = pattern.template.steps[idx];
          checkpoints.push({
            order: step.order,
            verifyAction: `Confirm: ${step.action}`,
            expected: step.expected,
            rollbackAction: `Undo last ${step.order} steps`
          });
        }
      }
    }

    return checkpoints;
  }

  /**
   * Estimate execution duration
   */
  estimateDuration(pattern) {
    const execTimes = this.successHistory
      .filter(h => pattern.observations?.some(obs =>
        obs.context.operation === h.operation
      ))
      .map(h => h.executionTime || 0)
      .filter(t => t > 0);

    if (execTimes.length === 0) {
      return { estimate: null, unit: 'ms' };
    }

    const avg = execTimes.reduce((a, b) => a + b, 0) / execTimes.length;
    const max = Math.max(...execTimes);

    return {
      estimate: Math.round(avg),
      min: Math.min(...execTimes),
      max,
      unit: 'ms',
      confidence: execTimes.length
    };
  }

  /**
   * Analyze prerequisites by frequency
   */
  analyzePrerequisites(pattern) {
    const prerequisites = new Map();

    const relevantOps = this.successHistory.filter(h =>
      pattern.observations?.some(obs =>
        obs.context.operation === h.operation
      )
    );

    for (const op of relevantOps) {
      if (op.steps) {
        for (const step of op.steps) {
          if (step.prerequisite) {
            prerequisites.set(
              step.prerequisite,
              (prerequisites.get(step.prerequisite) || 0) + 1
            );
          }
        }
      }
    }

    return Array.from(prerequisites.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([prereq, count]) => ({
        prerequisite: prereq,
        frequency: count
      }));
  }

  /**
   * Suggest optimization for operation
   */
  suggestOptimization(context) {
    const suggestion = this.suggestPattern(context);

    if (suggestion.matchType === 'none') {
      return {
        optimization: 'baseline',
        steps: ['Execute operation', 'Monitor results', 'Record outcome for future patterns']
      };
    }

    const pattern = suggestion.patterns?.[0] || suggestion.pattern;
    if (!pattern) {
      return null;
    }

    const slowestStep = this.findSlowestStep(pattern);
    const commonFailures = this.identifyRiskFactors(pattern);

    return {
      optimization: 'recommended',
      baselineSuccessRate: pattern.successRate,
      estimatedImprovement: 0.15, // 15% improvement expected
      suggestions: [
        pattern.template ? 'Use proven template' : null,
        slowestStep ? `Optimize step: ${slowestStep.action}` : null,
        commonFailures.length > 0 ? `Review common failures: ${commonFailures[0].reason}` : null
      ].filter(Boolean),
      riskLevel: pattern.failureCount > 0 ? 'medium' : 'low'
    };
  }

  /**
   * Find slowest step in pattern
   */
  findSlowestStep(pattern) {
    if (!pattern.template?.steps) {
      return null;
    }

    // This would require execution time data per step
    // Placeholder: return first complex step
    return pattern.template.steps.find(s =>
      s.action?.includes('deploy') || s.action?.includes('publish')
    ) || null;
  }

  /**
   * Cleanup old patterns (retention policy)
   */
  cleanupOldPatterns() {
    const cutoffDate = new Date(Date.now() - this.options.patternRetentionDays * 24 * 60 * 60 * 1000);
    const before = this.patterns.length;

    this.patterns = this.patterns.filter(p =>
      new Date(p.createdAt) >= cutoffDate || p.usageCount >= this.options.minSuccessCountForPattern
    );

    return {
      deletedCount: before - this.patterns.length,
      remainingCount: this.patterns.length,
      cutoffDate: cutoffDate.toISOString()
    };
  }

  /**
   * Get pattern statistics
   */
  getStatistics() {
    const totalPatterns = this.patterns.length;
    const avgSuccessRate = totalPatterns > 0
      ? this.patterns.reduce((sum, p) => sum + p.successRate, 0) / totalPatterns
      : 0;

    const usablePatterns = this.patterns.filter(p =>
      p.usageCount >= this.options.minSuccessCountForPattern &&
      p.successRate >= this.options.minSuccessRateForTemplate
    );

    return {
      totalPatterns,
      usablePatterns: usablePatterns.length,
      avgSuccessRate: Math.round(avgSuccessRate * 100) + '%',
      totalSuccesses: this.successHistory.length,
      totalFailures: this.failureHistory.length,
      overallSuccessRate: this.successHistory.length / (this.successHistory.length + this.failureHistory.length) || 0,
      patterns: this.patterns.map(p => ({
        id: p.id,
        category: p.category,
        successRate: Math.round(p.successRate * 100) + '%',
        usageCount: p.usageCount,
        lastUsed: p.lastUsedAt
      }))
    };
  }
}

module.exports = { ReuseEngine };
