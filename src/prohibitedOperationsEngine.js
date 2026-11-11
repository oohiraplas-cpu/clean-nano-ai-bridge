/**
 * Phase 8: Prohibited Operations Engine
 * Automated blocking of dangerous, irreversible, or permission-escalating operations
 *
 * Blocks these categories:
 * 1. Production deployments without explicit approval token
 * 2. Main branch modifications without explicit approval
 * 3. Permission/role changes without explicit approval
 * 4. Deletion operations (apps, solutions, data)
 * 5. Secret/credential modifications
 * 6. External sharing/access escalation
 * 7. Billing/subscription changes
 * 8. Solution exports without approval
 * 9. Data backups/exports without audit
 * 10. Cross-environment promotions
 */
const crypto = require('node:crypto');

/**
 * @typedef {Object} ProhibitionCheckResult
 * @property {boolean} allowed - true if operation is permitted
 * @property {string} verdict - "ALLOWED" | "BLOCKED" | "REQUIRES_APPROVAL"
 * @property {string[]} violations - list of violated policies
 * @property {Object} evidence - policy compliance evidence
 * @property {string} reason - explanation for decision
 * @property {string} remediationPath - how to proceed if blocked
 */

class ProhibitedOperationsEngine {
  constructor(options = {}) {
    this.options = {
      approvalRequired: options.approvalRequired !== false,
      auditLogging: options.auditLogging !== false,
      ...options
    };

    this.prohibitedCategories = [
      'production_deployment',
      'main_branch_modification',
      'permission_change',
      'deletion',
      'secret_modification',
      'external_sharing',
      'billing_change',
      'solution_export',
      'data_backup_export',
      'cross_environment_promotion'
    ];
  }

  /**
   * Check 1: Production deployment prohibition
   * Blocks deploy_to_test, publish_powerapps_app to production without approval
   */
  checkProductionDeployment(operation, approvalToken, environment) {
    const isProductionDeploy = (operation === 'deploy_to_test' || operation === 'publish_powerapps_app')
      && (environment === '本番' || environment === 'production' || environment?.includes('prod'));

    if (!isProductionDeploy) {
      return { blocked: false, reason: null };
    }

    const hasApproval = approvalToken && typeof approvalToken === 'string' && approvalToken.length > 8;

    return {
      blocked: !hasApproval,
      category: 'production_deployment',
      reason: hasApproval ? null : '本番へのデプロイは人間の明示承認トークンが必須です',
      requiredApproval: true,
      approvalProvided: hasApproval
    };
  }

  /**
   * Check 2: Main branch modification prohibition
   * Blocks operations that modify main/master branch
   */
  checkMainBranchModification(operation, targetBranch, approvalToken) {
    const isMainModification = (operation === 'save_powerapps_app' || operation === 'update_powerapps_app' || operation === 'publish_powerapps_app')
      && (targetBranch === 'main' || targetBranch === 'master');

    if (!isMainModification) {
      return { blocked: false, reason: null };
    }

    const hasApproval = approvalToken && typeof approvalToken === 'string' && approvalToken.length > 8;

    return {
      blocked: !hasApproval,
      category: 'main_branch_modification',
      reason: hasApproval ? null : 'main/masterブランチへの変更は人間の明示承認トークンが必須です',
      requiredApproval: true,
      branch: targetBranch,
      approvalProvided: hasApproval
    };
  }

  /**
   * Check 3: Permission/role change prohibition
   * Blocks update_permissions, grant_role, revoke_role
   */
  checkPermissionChange(operation, approvalToken) {
    const isPermissionChange = operation === 'update_permissions' ||
      operation === 'grant_role' ||
      operation === 'revoke_role' ||
      operation === 'change_ownership';

    if (!isPermissionChange) {
      return { blocked: false, reason: null };
    }

    const hasApproval = approvalToken && typeof approvalToken === 'string' && approvalToken.length > 8;

    return {
      blocked: !hasApproval,
      category: 'permission_change',
      reason: hasApproval ? null : '権限変更は人間の明示承認トークンが必須です',
      requiredApproval: true,
      approvalProvided: hasApproval
    };
  }

  /**
   * Check 4: Deletion operation prohibition
   * Blocks delete_app, delete_solution, delete_data, delete_list
   */
  checkDeletion(operation, targetName, approvalToken) {
    const isDeletion = operation.startsWith('delete_') || operation === 'remove_app' || operation === 'uninstall_solution';

    if (!isDeletion) {
      return { blocked: false, reason: null };
    }

    const hasApproval = approvalToken && typeof approvalToken === 'string' && approvalToken.length > 8;

    return {
      blocked: !hasApproval,
      category: 'deletion',
      reason: hasApproval ? null : '削除操作は人間の明示承認トークンが必須です（不可逆操作）',
      requiredApproval: true,
      operation,
      target: targetName,
      approvalProvided: hasApproval,
      warning: '削除操作は不可逆です。バックアップを確認してください。'
    };
  }

  /**
   * Check 5: Secret/credential modification prohibition
   * Blocks modifications to API keys, connection strings, credentials
   */
  checkSecretModification(operation, paramKeys = []) {
    const secretPatterns = /secret|password|key|token|credential|api.*key|connection.*string|auth.*token/i;
    const modifyingSecret = paramKeys?.some(key => secretPatterns.test(key));

    const isSecretOperation = operation === 'update_connection_secret' ||
      operation === 'rotate_api_key' ||
      operation === 'change_password' ||
      modifyingSecret;

    if (!isSecretOperation) {
      return { blocked: false, reason: null };
    }

    return {
      blocked: true,
      category: 'secret_modification',
      reason: 'Bridgeはシークレット値の変更を許可しません。デプロイメント環境で直接管理してください。',
      requiredApproval: false,
      operation,
      warning: 'シークレット変更は権限管理システムで実施してください'
    };
  }

  /**
   * Check 6: External sharing/access escalation prohibition
   * Blocks operations that grant external access or widen sharing scope
   */
  checkExternalSharing(operation, targetScope, currentScope = 'internal') {
    const isSharingOperation = operation === 'share_app' ||
      operation === 'grant_external_access' ||
      operation === 'create_shared_link' ||
      operation === 'change_sharing_scope';

    if (!isSharingOperation) {
      return { blocked: false, reason: null };
    }

    const externalScopes = ['public', 'external', 'anyone', 'anonymous'];
    const isExternalTarget = externalScopes.includes(targetScope?.toLowerCase());

    if (!isExternalTarget) {
      return { blocked: false, reason: null };
    }

    return {
      blocked: true,
      category: 'external_sharing',
      reason: '外部スコープへの共有はBridgeでは禁止されています。セキュリティ審査が必要な場合があります。',
      requiredApproval: false,
      operation,
      targetScope,
      currentScope,
      warning: 'データ外部共有は別途申請プロセスが必要です'
    };
  }

  /**
   * Check 7: Billing/subscription change prohibition
   * Blocks upgrade, downgrade, or license changes
   */
  checkBillingChange(operation, approvalToken) {
    const isBillingChange = operation === 'upgrade_license' ||
      operation === 'downgrade_license' ||
      operation === 'add_seats' ||
      operation === 'remove_seats' ||
      operation === 'change_subscription' ||
      operation === 'enable_premium_features';

    if (!isBillingChange) {
      return { blocked: false, reason: null };
    }

    const hasApproval = approvalToken && typeof approvalToken === 'string' && approvalToken.length > 8;

    return {
      blocked: !hasApproval,
      category: 'billing_change',
      reason: hasApproval ? null : 'ライセンス・課金変更は人間の明示承認トークンが必須です',
      requiredApproval: true,
      operation,
      approvalProvided: hasApproval,
      warning: '課金変更は契約内容・予算に影響します'
    };
  }

  /**
   * Check 8: Solution export prohibition
   * Blocks solution export operations
   */
  checkSolutionExport(operation, approvalToken) {
    const isSolutionExport = operation === 'export_solution' ||
      operation === 'export_unmanaged_solution' ||
      operation === 'backup_solution';

    if (!isSolutionExport) {
      return { blocked: false, reason: null };
    }

    const hasApproval = approvalToken && typeof approvalToken === 'string' && approvalToken.length > 8;

    return {
      blocked: !hasApproval,
      category: 'solution_export',
      reason: hasApproval ? null : 'Solutionエクスポートは人間の明示承認トークンが必須です',
      requiredApproval: true,
      operation,
      approvalProvided: hasApproval,
      warning: 'エクスポートされたSolutionには本番データが含まれる可能性があります'
    };
  }

  /**
   * Check 9: Data backup/export prohibition
   * Blocks data export operations
   */
  checkDataBackupExport(operation) {
    const isDataExport = operation === 'export_data' ||
      operation === 'backup_database' ||
      operation === 'download_records' ||
      operation === 'export_sharepoint_list';

    if (!isDataExport) {
      return { blocked: false, reason: null };
    }

    return {
      blocked: true,
      category: 'data_backup_export',
      reason: 'データエクスポートはBridgeでは禁止されています。ITスタッフに相談してください。',
      requiredApproval: false,
      operation,
      warning: 'データ持ち出しはセキュリティポリシー違反の可能性があります'
    };
  }

  /**
   * Check 10: Cross-environment promotion prohibition
   * Blocks promotions from dev to prod without proper workflow
   */
  checkCrossEnvironmentPromotion(operation, sourceEnv, targetEnv, approvalToken) {
    const isPromotion = operation === 'promote_solution' ||
      operation === 'deploy_to_test' ||
      operation === 'deploy_to_production';

    if (!isPromotion) {
      return { blocked: false, reason: null };
    }

    // Check if promoting to production
    const isProductionTarget = targetEnv === '本番' || targetEnv === 'production' || targetEnv?.includes('prod');

    if (!isProductionTarget) {
      return { blocked: false, reason: null };
    }

    const hasApproval = approvalToken && typeof approvalToken === 'string' && approvalToken.length > 8;

    return {
      blocked: !hasApproval,
      category: 'cross_environment_promotion',
      reason: hasApproval ? null: '本番環境への昇格は人間の明示承認トークンが必須です',
      requiredApproval: true,
      sourceEnv,
      targetEnv,
      approvalProvided: hasApproval,
      warning: '本番環境への昇格は十分なテストを伴うべきです'
    };
  }

  /**
   * Execute full prohibition check
   */
  check(context) {
    const {
      operation,
      approvalToken,
      environment,
      targetBranch,
      targetName,
      paramKeys,
      targetScope,
      currentScope,
      sourceEnv,
      targetEnv
    } = context;

    const checks = [
      this.checkProductionDeployment(operation, approvalToken, environment),
      this.checkMainBranchModification(operation, targetBranch, approvalToken),
      this.checkPermissionChange(operation, approvalToken),
      this.checkDeletion(operation, targetName, approvalToken),
      this.checkSecretModification(operation, paramKeys),
      this.checkExternalSharing(operation, targetScope, currentScope),
      this.checkBillingChange(operation, approvalToken),
      this.checkSolutionExport(operation, approvalToken),
      this.checkDataBackupExport(operation),
      this.checkCrossEnvironmentPromotion(operation, sourceEnv, targetEnv, approvalToken)
    ];

    const violations = checks.filter(c => c.blocked && !c.reason?.includes('null'));
    const blocked = violations.length > 0;

    const reasons = violations
      .filter(v => v.reason)
      .map(v => v.reason);

    const required = violations
      .filter(v => v.requiredApproval)
      .map(v => v.category);

    const verdict = blocked ? 'BLOCKED' : 'ALLOWED';

    return {
      allowed: !blocked,
      verdict,
      blocked,
      violations: violations.map(v => v.category),
      checksPerformed: checks.length,
      checksBlocked: violations.length,
      evidence: {
        operation,
        approvalToken: !!approvalToken,
        environment,
        targetBranch,
        checks: checks.map(c => ({ category: c.category, blocked: c.blocked }))
      },
      reasons,
      requiresApprovalCategories: required,
      remediationPath: required.length > 0
        ? `人間承認トークンを取得: ${required.join(', ')}`
        : null,
      timestamp: new Date().toISOString(),
      assessmentId: crypto.randomUUID()
    };
  }
}

module.exports = { ProhibitedOperationsEngine };
