/**
 * Policy Engine: Centralized Policy Management
 *
 * Evaluates and enforces policies for all write operations.
 * Policies define prohibitions, approval requirements, and recovery actions.
 */

/**
 * Standard Policy Definitions
 */
const DEFAULT_POLICIES = {
  // Prohibition: Direct writes to main branch
  MAIN_BRANCH_PROTECTED: {
    id: 'policy:main-branch-protected',
    version: '1.0.0',
    description: 'Prohibit direct writes to main/canonical branch',
    target: { branch: 'main' },
    effect: 'deny',
    recoveryAction: 'Use feature branch and pull request',
    code: 'POLICY_MAIN_BRANCH_PROTECTED'
  },

  // Prohibition: Non-canonical branch writes
  NON_CANONICAL_DENIED: {
    id: 'policy:non-canonical-denied',
    version: '1.0.0',
    description: 'Prohibit writes to non-canonical branches',
    target: { sourceOrigin: ['fallback', 'other'] },
    effect: 'deny',
    recoveryAction: 'Update canonical branch only',
    code: 'POLICY_NON_CANONICAL_DENIED'
  },

  // Prohibition: Incomplete context
  CONTEXT_REQUIRED: {
    id: 'policy:context-required',
    version: '1.0.0',
    description: 'Require complete State Context V2',
    conditions: ['stateContextComplete:true'],
    effect: 'deny',
    recoveryAction: 'Provide complete State Context with all 10 required fields',
    code: 'POLICY_CONTEXT_REQUIRED'
  },

  // Prohibition: TTL/SHA/Lock failures
  STATE_INTEGRITY_REQUIRED: {
    id: 'policy:state-integrity',
    version: '1.0.0',
    description: 'Require valid TTL, SHA, and lock status',
    conditions: ['ttlValid:true', 'shaValid:true', 'lockAcquired:true'],
    effect: 'deny',
    recoveryAction: 'Revalidate context and acquire lock',
    code: 'POLICY_STATE_INTEGRITY_FAILED'
  },

  // Prohibition: Unauthorized publish
  PUBLISH_REQUIRES_APPROVAL: {
    id: 'policy:publish-approval',
    version: '1.0.0',
    description: 'Require human approval for publish operations',
    target: { operationType: 'publish' },
    approvalRequired: true,
    effect: 'require_approval',
    recoveryAction: 'Request human approval for publish',
    code: 'POLICY_PUBLISH_APPROVAL_REQUIRED'
  },

  // Prohibition: Unauthorized merge
  MERGE_REQUIRES_APPROVAL: {
    id: 'policy:merge-approval',
    version: '1.0.0',
    description: 'Require human approval for merge operations',
    target: { operationType: 'merge' },
    approvalRequired: true,
    effect: 'require_approval',
    recoveryAction: 'Request human approval for merge',
    code: 'POLICY_MERGE_APPROVAL_REQUIRED'
  },

  // Prohibition: Unauthorized deployment
  DEPLOY_PROD_DENIED: {
    id: 'policy:deploy-prod-denied',
    version: '1.0.0',
    description: 'Prohibit direct production deployments',
    target: { operationType: 'deploy', environment: 'production' },
    effect: 'deny',
    recoveryAction: 'Deploy to test environment first',
    code: 'POLICY_DEPLOY_PROD_DENIED'
  },

  // Prohibition: Unauthorized deletion
  DELETION_PROHIBITED: {
    id: 'policy:deletion-prohibited',
    version: '1.0.0',
    description: 'Prohibit deletion operations',
    target: { operationType: 'delete' },
    effect: 'deny',
    recoveryAction: 'Archive instead of delete, with human approval',
    code: 'POLICY_DELETION_PROHIBITED'
  },

  // Prohibition: Unauthorized rename
  RENAME_REQUIRES_APPROVAL: {
    id: 'policy:rename-approval',
    version: '1.0.0',
    description: 'Require approval for rename/refactor operations',
    target: { operationType: 'rename' },
    approvalRequired: true,
    effect: 'require_approval',
    recoveryAction: 'Request human approval for rename',
    code: 'POLICY_RENAME_APPROVAL_REQUIRED'
  },

  // Prohibition: Unauthorized permission changes
  PERMISSIONS_REQUIRE_APPROVAL: {
    id: 'policy:permissions-approval',
    version: '1.0.0',
    description: 'Require approval for permission changes',
    target: { operationType: 'update_permissions' },
    approvalRequired: true,
    effect: 'require_approval',
    recoveryAction: 'Request human approval for permission changes',
    code: 'POLICY_PERMISSIONS_APPROVAL_REQUIRED'
  },

  // Prohibition: Unauthorized public disclosure
  PUBLIC_DISCLOSURE_DENIED: {
    id: 'policy:public-disclosure-denied',
    version: '1.0.0',
    description: 'Prohibit public disclosure of internal data',
    target: { operationType: 'public_share' },
    effect: 'deny',
    recoveryAction: 'Remove public sharing, maintain internal only',
    code: 'POLICY_PUBLIC_DISCLOSURE_DENIED'
  },

  // Prohibition: Billing/Charges
  BILLING_CHANGE_DENIED: {
    id: 'policy:billing-change-denied',
    version: '1.0.0',
    description: 'Prohibit operations that incur charges',
    target: { operationType: 'billing_change' },
    effect: 'deny',
    recoveryAction: 'Requires explicit budget approval',
    code: 'POLICY_BILLING_CHANGE_DENIED'
  },

  // Prohibition: Secret value disclosure
  SECRET_DISCLOSURE_DENIED: {
    id: 'policy:secret-disclosure-denied',
    version: '1.0.0',
    description: 'Prohibit logging/exposing secret values',
    target: { containsSecrets: true },
    effect: 'deny',
    recoveryAction: 'Remove secret values from logs/audit trail',
    code: 'POLICY_SECRET_DISCLOSURE_DENIED'
  },

  // Prohibition: Audit trail tampering
  AUDIT_IMMUTABLE: {
    id: 'policy:audit-immutable',
    version: '1.0.0',
    description: 'Prohibit modification of audit trails',
    target: { operationType: 'modify_audit' },
    effect: 'deny',
    recoveryAction: 'Audit trails are append-only; contact audit administrator',
    code: 'POLICY_AUDIT_IMMUTABLE'
  }
};

/**
 * Policy Engine class
 */
class PolicyEngine {
  constructor(policies = DEFAULT_POLICIES) {
    this.policies = new Map(Object.entries(policies));
    this.policyVersion = '1.0.0';
  }

  /**
   * Evaluate policies against an operation
   *
   * @param {Object} params - { operationType, context, policy, ...overrides }
   * @returns {Promise<Object>} { allowed, reason, recoveryAction, code, approvalRequired }
   */
  async evaluatePolicy(params = {}) {
    const {
      operationType = 'save',
      context = {},
      policy = {},
      ...metadata
    } = params;

    // Collect all applicable policies
    const applicablePolicies = this._findApplicablePolicies({
      operationType,
      context,
      ...metadata
    });

    // Evaluate each policy
    for (const policyDef of applicablePolicies) {
      const evaluation = this._evaluatePolicy(policyDef, {
        operationType,
        context,
        ...metadata
      });

      if (!evaluation.allowed) {
        return {
          allowed: false,
          reason: policyDef.description,
          recoveryAction: policyDef.recoveryAction,
          code: policyDef.code,
          approvalRequired: policyDef.approvalRequired || false
        };
      }

      // If approval required, stop evaluation and request approval
      if (policyDef.approvalRequired && policyDef.effect === 'require_approval') {
        return {
          allowed: true,
          reason: policyDef.description,
          recoveryAction: policyDef.recoveryAction,
          code: policyDef.code,
          approvalRequired: true
        };
      }
    }

    // All policies passed
    return {
      allowed: true,
      reason: 'All policies satisfied',
      code: 'POLICY_OK',
      approvalRequired: false
    };
  }

  /**
   * Register a new policy
   */
  registerPolicy(id, policyDef) {
    if (this.policies.has(id)) {
      throw new Error(`Policy ${id} already registered`);
    }
    this.policies.set(id, policyDef);
  }

  /**
   * Update an existing policy
   */
  updatePolicy(id, policyDef) {
    if (!this.policies.has(id)) {
      throw new Error(`Policy ${id} not found`);
    }
    this.policies.set(id, { ...this.policies.get(id), ...policyDef });
  }

  /**
   * List all policies
   */
  listPolicies() {
    return Array.from(this.policies.values());
  }

  /**
   * Find applicable policies for an operation
   */
  _findApplicablePolicies(params) {
    const applicable = [];

    for (const [id, policyDef] of this.policies) {
      // Check if policy applies to this operation type
      if (policyDef.target?.operationType && policyDef.target.operationType !== params.operationType) {
        continue;
      }

      // Check if policy applies to this branch
      if (policyDef.target?.branch && policyDef.target.branch !== params.context?.source?.branch) {
        continue;
      }

      // Check if policy applies to this source origin
      if (policyDef.target?.sourceOrigin) {
        const targets = Array.isArray(policyDef.target.sourceOrigin)
          ? policyDef.target.sourceOrigin
          : [policyDef.target.sourceOrigin];
        if (!targets.includes(params.context?.source?.sourceOrigin)) {
          continue;
        }
      }

      // Policy is applicable
      applicable.push(policyDef);
    }

    return applicable;
  }

  /**
   * Evaluate a single policy
   */
  _evaluatePolicy(policyDef, params) {
    switch (policyDef.effect) {
      case 'deny':
        return { allowed: false };
      case 'require_approval':
        return { allowed: false, needsApproval: true };
      case 'allow':
        return { allowed: true };
      default:
        return { allowed: true };
    }
  }

  /**
   * Evaluate policy conditions (future enhancement for complex rules)
   */
  _evaluateConditions(conditions = [], params = {}) {
    for (const condition of conditions) {
      if (!this._evaluateCondition(condition, params)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Evaluate a single condition
   */
  _evaluateCondition(condition, params) {
    if (!condition) return true;

    // Handle simple conditions like 'ttlValid:true'
    const [key, value] = condition.split(':');
    return params[key] === (value === 'true');
  }

  /**
   * Check if operation requires human approval
   */
  requiresApproval(operationType, context) {
    const applicable = this._findApplicablePolicies({ operationType, context });
    return applicable.some(p => p.approvalRequired);
  }

  /**
   * Get policy summary
   */
  getSummary() {
    return {
      version: this.policyVersion,
      totalPolicies: this.policies.size,
      policies: Array.from(this.policies.values()).map(p => ({
        id: p.id,
        description: p.description,
        effect: p.effect,
        approvalRequired: p.approvalRequired || false
      }))
    };
  }
}

module.exports = {
  DEFAULT_POLICIES,
  PolicyEngine
};
