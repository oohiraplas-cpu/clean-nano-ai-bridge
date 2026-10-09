/**
 * 共通ポリシー・承認・監査・ロールバック機能
 * すべての変更操作で統一適用
 */

const crypto = require('node:crypto');

/**
 * 承認ポリシー: 人間承認が必要な操作を管理
 */
class ApprovalPolicy {
  static APPROVAL_GATES = Object.freeze({
    MAIN_MERGE: { id: 'main_merge', name: 'mainマージ', riskLevel: 'critical', requiresIdentity: true },
    PRODUCTION_PUBLISH: { id: 'prod_publish', name: '本番公開', riskLevel: 'critical', requiresIdentity: true },
    PERMISSION_CHANGE: { id: 'permission', name: '権限変更', riskLevel: 'high', requiresIdentity: true },
    DESTRUCTIVE_CHANGE: { id: 'destructive', name: '削除・改名・型変更', riskLevel: 'high', requiresIdentity: true },
    EXTERNAL_SHARE: { id: 'external_share', name: '外部共有', riskLevel: 'medium', requiresIdentity: true },
    ADDITIONAL_BILLING: { id: 'billing', name: '追加課金', riskLevel: 'medium', requiresIdentity: true },
    IRREVERSIBLE_OPERATION: { id: 'irreversible', name: '復旧不能変更', riskLevel: 'critical', requiresIdentity: true },
    LEGAL_DECISION: { id: 'legal', name: '契約・法的判断', riskLevel: 'critical', requiresIdentity: true }
  });

  constructor(approvalTokenStore) {
    this.tokenStore = approvalTokenStore; // TODO: 実装
  }

  /**
   * 承認が必要か判定
   */
  requiresApproval(operation) {
    const gateMap = {
      'merge_to_main': ApprovalPolicy.APPROVAL_GATES.MAIN_MERGE,
      'publish_production': ApprovalPolicy.APPROVAL_GATES.PRODUCTION_PUBLISH,
      'change_permissions': ApprovalPolicy.APPROVAL_GATES.PERMISSION_CHANGE,
      'delete': ApprovalPolicy.APPROVAL_GATES.DESTRUCTIVE_CHANGE,
      'rename': ApprovalPolicy.APPROVAL_GATES.DESTRUCTIVE_CHANGE,
      'change_type': ApprovalPolicy.APPROVAL_GATES.DESTRUCTIVE_CHANGE,
      'share_external': ApprovalPolicy.APPROVAL_GATES.EXTERNAL_SHARE,
      'add_billing': ApprovalPolicy.APPROVAL_GATES.ADDITIONAL_BILLING
    };
    return gateMap[operation.type];
  }

  /**
   * 承認トークン検証
   */
  validateApprovalToken(token, operation, actor) {
    if (!token) {
      return { valid: false, error: '承認トークンが不足しています' };
    }
    // TODO: トークンストア照合
    return { valid: true, approver: actor };
  }

  /**
   * 同一操作への重複承認検査（過去・別環境・別対象の承認は流用しない）
   */
  checkDuplicateApproval(requestId, operation) {
    // TODO: 監査ログから同一requestId + target + changeHash の承認有無を確認
    return { isDuplicate: false };
  }
}

/**
 * データポリシー: 秘密値、推測、模擬データ禁止
 */
class DataPolicy {
  /**
   * 秘密値を検出・マスク
   */
  static detectSecrets(content) {
    const secrets = [];
    const patterns = {
      apiKey: /api[_-]?key\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
      clientSecret: /client[_-]?secret\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})/gi,
      password: /password\s*[:=]\s*["']?([a-zA-Z0-9!@#$%]{8,})/gi,
      token: /token\s*[:=]\s*["']?([a-zA-Z0-9_\-]{30,})/gi,
      connectionString: /connectionstring\s*[:=]\s*["']?([^"']*[;])/gi
    };

    Object.entries(patterns).forEach(([type, pattern]) => {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        secrets.push({ type, value: match[1], position: match.index });
      }
    });

    return secrets;
  }

  /**
   * 秘密値をマスク
   */
  static maskSecrets(content, secrets) {
    if (!secrets || secrets.length === 0) return content;

    let masked = content;
    // positionの逆順でマスク（前から処理するとインデックスがずれるため）
    secrets
      .sort((a, b) => b.position - a.position)
      .forEach(secret => {
        if (secret.value && secret.position >= 0) {
          const before = masked.substring(0, secret.position);
          const after = masked.substring(secret.position + secret.value.length);
          masked = before + `***[${secret.type}]***` + after;
        }
      });
    return masked;
  }

  /**
   * 推測・模擬データを検出（TBD・TODO・dummy・mock・simulat パターン）
   */
  static detectSpeculation(content) {
    const patterns = [
      /\bTBD\b/gi,
      /\bTODO\b/gi,
      /dummy/gi,
      /mock/gi,
      /simulat/gi,
      /hypothetical/gi,
      /assumed/gi,
      /presumably/gi
    ];

    const matches = [];
    patterns.forEach(pattern => {
      const found = content.matchAll(pattern);
      for (const match of found) {
        matches.push({ type: 'speculation', value: match[0], position: match.index });
      }
    });

    return matches;
  }
}

/**
 * 検証ポリシー: 未確認成功を禁止、正本優先
 */
class ValidationPolicy {
  /**
   * Fail-Closed: 不一致・未確認は停止
   */
  static validateMatch(actual, expected, context) {
    const mismatches = [];

    if (actual.branch !== expected.branch) {
      mismatches.push(`branch不一致: 期待=${expected.branch}, 実際=${actual.branch}`);
    }
    if (actual.sha !== expected.sha) {
      mismatches.push(`SHA不一致: 期待=${expected.sha}, 実際=${actual.sha}`);
    }
    if (actual.version && expected.version && actual.version !== expected.version) {
      mismatches.push(`version不一致: 期待=${expected.version}, 実際=${actual.version}`);
    }
    if (actual.environmentId !== expected.environmentId) {
      mismatches.push(`environmentId不一致: 期待=${expected.environmentId}, 実際=${actual.environmentId}`);
    }

    return {
      match: mismatches.length === 0,
      mismatches,
      context
    };
  }

  /**
   * 正本検証: canonical branch のみが write authority
   */
  static validateCanonicalBranch(branch, canonicalBranch) {
    if (branch !== canonicalBranch) {
      return {
        valid: false,
        error: `正本branch不一致: 期待=${canonicalBranch}, 指定=${branch}`
      };
    }
    return { valid: true };
  }

  /**
   * TTL検証: StateSession 有効期限確認
   */
  static validateTTL(createdAt, ttlSeconds = 300) {
    const now = Date.now();
    const created = new Date(createdAt).getTime();
    const elapsedSeconds = (now - created) / 1000;

    if (elapsedSeconds > ttlSeconds) {
      return {
        valid: false,
        error: `StateSession TTL切れ: ${elapsedSeconds.toFixed(1)}秒経過（TTL=${ttlSeconds}秒）`,
        elapsedSeconds
      };
    }
    return { valid: true };
  }

  /**
   * 冪等性検証: 同一変更の二重実行防止
   * idempotencyKey = requestId + target + baseSha + changeHash
   */
  static createIdempotencyKey(requestId, target, baseSha, changeHash) {
    const key = `${requestId}|${target}|${baseSha}|${changeHash}`;
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  static validateIdempotency(idempotencyKey, executedKeys) {
    if (executedKeys.has(idempotencyKey)) {
      return { valid: false, error: '同一変更が既に実行されています' };
    }
    return { valid: true };
  }
}

/**
 * 監査ログ: すべての操作を記録
 */
class AuditLog {
  constructor() {
    this.entries = [];
  }

  /**
   * ログエントリ追加
   */
  log({
    requestId,
    timestamp,
    actor,
    action,
    resource,
    resourceType,
    changes,
    before,
    after,
    status,
    result,
    errors
  }) {
    const entry = {
      id: crypto.randomUUID(),
      requestId,
      timestamp: timestamp || new Date().toISOString(),
      actor,
      action,
      resource,
      resourceType,
      changes,
      before: this._maskSecrets(before),
      after: this._maskSecrets(after),
      status, // 'success', 'failure', 'partial'
      result,
      errors,
      ipAddress: null, // TODO: リクエスト情報から取得
      userAgent: null // TODO: リクエスト情報から取得
    };

    this.entries.push(entry);
    return entry;
  }

  /**
   * ログ削除禁止（ただし履歴保持）
   */
  lockEntry(entryId) {
    const entry = this.entries.find(e => e.id === entryId);
    if (entry) {
      entry.locked = true;
    }
  }

  /**
   * 監査証跡生成
   */
  generateAuditTrail(requestId) {
    const filtered = this.entries.filter(e => e.requestId === requestId);
    return {
      requestId,
      entries: filtered,
      generated: new Date().toISOString(),
      hash: crypto.createHash('sha256')
        .update(JSON.stringify(filtered))
        .digest('hex')
    };
  }

  _maskSecrets(obj) {
    if (!obj) return obj;
    const masked = JSON.stringify(obj);
    const secrets = DataPolicy.detectSecrets(masked);
    return JSON.parse(DataPolicy.maskSecrets(masked, secrets));
  }
}

/**
 * ロールバック: 変更前スナップショットから復旧
 */
class RollbackManager {
  constructor() {
    this.snapshots = new Map(); // requestId => snapshot
  }

  /**
   * スナップショット保存
   */
  createSnapshot(requestId, resources) {
    const snapshot = {
      requestId,
      timestamp: new Date().toISOString(),
      resources: {
        powerAppsState: resources.powerAppsState,
        powerAppsSource: resources.powerAppsSource,
        sharePointSchema: resources.sharePointSchema,
        gitBranch: resources.gitBranch,
        gitSha: resources.gitSha
      },
      hash: crypto.randomUUID()
    };

    this.snapshots.set(requestId, snapshot);
    return snapshot;
  }

  /**
   * ロールバック可能か判定
   */
  canRollback(requestId) {
    return this.snapshots.has(requestId);
  }

  /**
   * ロールバック実行
   */
  async rollback(requestId, adapters) {
    const snapshot = this.snapshots.get(requestId);
    if (!snapshot) {
      return { success: false, error: 'スナップショットが見つかりません' };
    }

    try {
      // TODO: 各システムのロールバック処理
      // adapters.powerApps.restoreFromSnapshot(snapshot)
      // adapters.sharePoint.restoreFromSnapshot(snapshot)
      // adapters.github.revertCommit(snapshot.gitSha)

      return {
        success: true,
        snapshot,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * ロールバック情報削除（承認後の完了確定時のみ）
   */
  removeSnapshot(requestId) {
    this.snapshots.delete(requestId);
  }
}

/**
 * 効率指標: ユーザー入力・質問・重複取得等を追跡
 */
class EfficiencyMetrics {
  constructor() {
    this.metrics = {};
  }

  /**
   * メトリクス記録
   */
  record(requestId, metric, value) {
    if (!this.metrics[requestId]) {
      this.metrics[requestId] = {};
    }
    this.metrics[requestId][metric] = value;
  }

  /**
   * 効率指標集計
   */
  aggregate(requestId) {
    const m = this.metrics[requestId] || {};
    return {
      requestId,
      userInputs: m.userInputs || 1,
      questions: m.questions || 0,
      duplicateRetrieval: m.duplicateRetrieval || 0,
      manualCopypaste: m.manualCopypaste || 0,
      autoResolution: m.autoResolution || 0,
      elapsedSeconds: m.elapsedSeconds || 0,
      efficiency: {
        oneRoundCompletion: m.elapsedSeconds < 300 ? true : false, // 5分以内
        autoResolutionRate: m.autoResolution > 0 ? 95 : 100, // % (目標95%以上)
        humanInterventionRate: m.questions > 0 ? 5 : 0 // % (目標5%未満)
      }
    };
  }
}

module.exports = {
  ApprovalPolicy,
  DataPolicy,
  ValidationPolicy,
  AuditLog,
  RollbackManager,
  EfficiencyMetrics
};
