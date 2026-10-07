/**
 * Phase 8 Prohibited Operations Engine
 * 危険操作を自動ブロック
 */

class ProhibitedOpsEngine {
  constructor() {
    this.prohibitedOps = {
      'secret_leak': {
        pattern: /(?:password|token|apiKey|secret|auth|credential)\s*[:=]/i,
        severity: 'critical',
        message: '秘密値が含まれています。操作をブロック。'
      },
      'branch_mismatch': {
        message: 'Branch不一致。正本ブランチのみ許可。',
        severity: 'critical'
      },
      'sha_mismatch': {
        message: 'SHA不一致。コミット SHA の検証が必要。',
        severity: 'critical'
      },
      'delete_operation': {
        pattern: /delete|remove|destroy/i,
        message: '削除操作は禁止。既存アプリ・ソースは保全が優先。',
        severity: 'critical'
      },
      'rename_operation': {
        pattern: /rename|move|refactor_name/i,
        message: 'リネーム操作は禁止。破壊的変更の可能性。',
        severity: 'critical'
      },
      'duplicate_creation': {
        message: '同名オブジェクトの重複作成を禁止。',
        severity: 'critical'
      },
      'permission_escalation': {
        message: '権限昇格は禁止。Human承認なしでは実行不可。',
        severity: 'critical'
      },
      'production_deploy': {
        message: '本番環境へのデプロイは禁止。',
        severity: 'critical'
      }
    };
  }

  /**
   * 操作の安全性を検証
   * @param {Object} operation
   * @param {string} operation.method
   * @param {Object} operation.params
   * @returns {Object} { allowed, blocked, reasons }
   */
  validate(operation) {
    const { method, params } = operation;
    const blocked = [];
    const reasons = [];

    // 1. Secret leak チェック
    if (this._hasSecretLeak(JSON.stringify(params))) {
      blocked.push('secret_leak');
      reasons.push(this.prohibitedOps.secret_leak.message);
    }

    // 2. Branch mismatch チェック
    if (params.branch && params.canonicalBranch && params.branch !== params.canonicalBranch) {
      blocked.push('branch_mismatch');
      reasons.push(this.prohibitedOps.branch_mismatch.message);
    }

    // 3. SHA format チェック
    if (params.sha && !this._isValidSha(params.sha)) {
      blocked.push('sha_mismatch');
      reasons.push(this.prohibitedOps.sha_mismatch.message);
    }

    // 4. 削除操作をチェック
    if (method.match(/delete|remove|destroy/i)) {
      blocked.push('delete_operation');
      reasons.push(this.prohibitedOps.delete_operation.message);
    }

    // 5. リネーム操作をチェック
    if (method.match(/rename|move/i)) {
      blocked.push('rename_operation');
      reasons.push(this.prohibitedOps.rename_operation.message);
    }

    // 6. 本番デプロイをチェック
    if (method === 'deploy_to_test' || method === 'deploy_to_production') {
      blocked.push('production_deploy');
      reasons.push(this.prohibitedOps.production_deploy.message);
    }

    // 7. 権限昇格をチェック
    if (method === 'update_permissions' && !params.approvedByHuman) {
      blocked.push('permission_escalation');
      reasons.push(this.prohibitedOps.permission_escalation.message);
    }

    // 8. 重複作成をチェック
    if (method.match(/create/) && params.name && params.allowDuplicate !== true) {
      // 実装時に既存リソースと照合
    }

    return {
      allowed: blocked.length === 0,
      blocked,
      reasons,
      severity: blocked.length > 0 ? 'critical' : 'none'
    };
  }

  /**
   * Secret leak 検出
   */
  _hasSecretLeak(str) {
    return this.prohibitedOps.secret_leak.pattern.test(str);
  }

  /**
   * SHA形式検証
   */
  _isValidSha(sha) {
    // 40文字の16進数
    return /^[a-f0-9]{40}$/i.test(sha);
  }

  /**
   * リスク評価
   */
  assessRisk(operation) {
    const validation = this.validate(operation);

    if (!validation.allowed) {
      return {
        risk_level: 'CRITICAL',
        action: 'BLOCK',
        reasons: validation.reasons
      };
    }

    return {
      risk_level: 'SAFE',
      action: 'ALLOW',
      reasons: []
    };
  }

  /**
   * フォールバック branch への書込みをチェック
   */
  preventFallbackWrite(branch, canonicalBranch) {
    if (branch !== canonicalBranch) {
      return {
        blocked: true,
        reason: `Fallback branch "${branch}" への書込みを禁止。正本ブランチ "${canonicalBranch}" のみ許可。`
      };
    }

    return { blocked: false };
  }

  /**
   * 旧 branch への書込みをチェック
   */
  preventOldBranchWrite(branch, mainBranch = 'main') {
    const oldBranchPatterns = ['old_', 'legacy_', 'deprecated_', 'backup_'];

    if (oldBranchPatterns.some(pattern => branch.startsWith(pattern))) {
      return {
        blocked: true,
        reason: `旧ブランチ "${branch}" への書込みを禁止。`
      };
    }

    return { blocked: false };
  }

  /**
   * Safe mode: 読取専用操作のみ許可
   */
  isSafeReadOnly(method) {
    const readOnlyMethods = [
      'health_check',
      'get_',
      'inspect_',
      'list_',
      'resolve_'
    ];

    return readOnlyMethods.some(prefix => method.startsWith(prefix));
  }
}

module.exports = ProhibitedOpsEngine;
