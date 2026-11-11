/**
 * Phase 14: Comprehensive Health Check System
 * 
 * 総合ヘルスチェックシステム。3AI共通Bridge実行規則に基づき、実環境の状態を
 * 定期的に監視・レポートし、問題を自動検出する。
 * 
 * 主要な機能：
 * 1. Health Check Registry - 各コンポーネントのステータス管理
 * 2. Dependency Verifier - コンポーネント間の依存関係検証
 * 3. Remediation Advisor - 問題時の自動修復提案
 */

const crypto = require('node:crypto');

class HealthCheckRegistry {
  constructor(options = {}) {
    this.checkResults = new Map(); // componentId -> status record
    this.statusHistory = new Map(); // componentId -> [history records]
    this.retentionDays = options.retentionDays || 7;
    this.maxHistoryPerComponent = options.maxHistoryPerComponent || 288; // 24h * 12 checks/hour
    this.lastCleanupTime = Date.now();
  }

  /**
   * ヘルスチェック結果を記録する
   * @param {string} componentId - コンポーネントID
   * @param {object} result - チェック結果
   */
  recordCheck(componentId, result) {
    if (!componentId || typeof componentId !== 'string') {
      throw new Error('Invalid componentId');
    }
    if (!result || typeof result !== 'object') {
      throw new Error('Invalid result');
    }

    const timestamp = new Date().toISOString();
    const checkId = crypto.randomUUID();

    // Validate result structure
    const status = result.healthy === true ? 'healthy' : result.healthy === false ? 'unhealthy' : 'unknown';
    const severity = result.severity || (status === 'unhealthy' ? 'error' : 'info');

    const record = {
      checkId,
      componentId,
      timestamp,
      status,
      severity,
      metrics: result.metrics || {},
      issues: result.issues || [],
      lastUpdated: result.lastUpdated,
      responseTime: result.responseTime || 0,
      version: result.version
    };

    // Store current status
    this.checkResults.set(componentId, record);

    // Store in history
    if (!this.statusHistory.has(componentId)) {
      this.statusHistory.set(componentId, []);
    }
    const history = this.statusHistory.get(componentId);
    history.push(record);

    // Keep history size under limit
    if (history.length > this.maxHistoryPerComponent) {
      history.shift();
    }

    // Periodic cleanup
    if (Date.now() - this.lastCleanupTime > 3600000) {
      this.cleanupOldHistory();
      this.lastCleanupTime = Date.now();
    }

    return { checkId, timestamp, status, severity };
  }

  /**
   * コンポーネントのステータスを取得する
   * @param {string} componentId - コンポーネントID
   */
  getStatus(componentId) {
    return this.checkResults.get(componentId) || null;
  }

  /**
   * すべてのコンポーネントのステータスを取得する
   */
  getAllStatus() {
    const statuses = Array.from(this.checkResults.values());
    const healthyCount = statuses.filter(s => s.status === 'healthy').length;
    const unhealthyCount = statuses.filter(s => s.status === 'unhealthy').length;
    const unknownCount = statuses.filter(s => s.status === 'unknown').length;

    return {
      components: statuses,
      summary: {
        totalComponents: statuses.length,
        healthyCount,
        unhealthyCount,
        unknownCount,
        overallStatus: unhealthyCount > 0 ? 'unhealthy' : healthyCount > 0 ? 'healthy' : 'unknown'
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * コンポーネントの履歴を取得する
   * @param {string} componentId - コンポーネントID
   */
  getHistory(componentId) {
    return this.statusHistory.get(componentId) || [];
  }

  /**
   * 指定した期間のステータスを取得する
   * @param {string} componentId - コンポーネントID
   * @param {number} minutesBack - 過去N分
   */
  getStatusWindow(componentId, minutesBack = 60) {
    const history = this.getHistory(componentId);
    const cutoffTime = new Date(Date.now() - minutesBack * 60000).getTime();

    return history.filter(record => {
      const recordTime = new Date(record.timestamp).getTime();
      return recordTime >= cutoffTime;
    });
  }

  /**
   * ステータス変化を検出する
   * @param {string} componentId - コンポーネントID
   */
  detectStatusChange(componentId) {
    const history = this.getHistory(componentId);
    if (history.length < 2) {
      return null;
    }

    const current = history[history.length - 1];
    const previous = history[history.length - 2];

    if (current.status !== previous.status) {
      return {
        componentId,
        from: previous.status,
        to: current.status,
        changedAt: current.timestamp,
        previousAt: previous.timestamp
      };
    }

    return null;
  }

  cleanupOldHistory() {
    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMs;

    for (const [componentId, history] of this.statusHistory.entries()) {
      const filtered = history.filter(record => {
        const recordTime = new Date(record.timestamp).getTime();
        return recordTime >= cutoffTime;
      });

      if (filtered.length === 0) {
        this.statusHistory.delete(componentId);
      } else if (filtered.length < history.length) {
        this.statusHistory.set(componentId, filtered);
      }
    }
  }

  getStats() {
    let totalChecks = 0;
    for (const history of this.statusHistory.values()) {
      totalChecks += history.length;
    }

    return {
      registeredComponents: this.checkResults.size,
      totalHistoryRecords: totalChecks,
      timestamp: new Date().toISOString()
    };
  }
}

class DependencyVerifier {
  constructor(options = {}) {
    this.dependencies = new Map(); // componentId -> [depends on]
    this.verificationResults = new Map(); // correlationId -> result
  }

  /**
   * コンポーネント間の依存関係を定義する
   * @param {string} componentId - コンポーネントID
   * @param {array} dependsOn - 依存先コンポーネント配列
   */
  defineDependency(componentId, dependsOn) {
    if (!componentId || typeof componentId !== 'string') {
      throw new Error('Invalid componentId');
    }
    if (!Array.isArray(dependsOn)) {
      throw new Error('dependsOn must be an array');
    }

    this.dependencies.set(componentId, dependsOn);
    return { componentId, dependsOn };
  }

  /**
   * 依存関係を検証する
   * @param {string} componentId - コンポーネントID
   * @param {object} statusRegistry - HealthCheckRegistry
   */
  verifyDependencies(componentId, statusRegistry) {
    const correlationId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    if (!this.dependencies.has(componentId)) {
      return {
        correlationId,
        componentId,
        timestamp,
        verified: true,
        noDependencies: true,
        issues: []
      };
    }

    const dependsOn = this.dependencies.get(componentId);
    const issues = [];
    let allVerified = true;

    for (const dependency of dependsOn) {
      const depStatus = statusRegistry.getStatus(dependency);

      if (!depStatus) {
        issues.push({
          dependency,
          reason: 'Dependency status unknown'
        });
        allVerified = false;
      } else if (depStatus.status !== 'healthy') {
        issues.push({
          dependency,
          reason: `Dependency unhealthy: ${depStatus.status}`,
          severity: depStatus.severity
        });
        allVerified = false;
      }
    }

    const result = {
      correlationId,
      componentId,
      timestamp,
      verified: allVerified,
      dependenciesChecked: dependsOn.length,
      issues,
      noDependencies: false
    };

    this.verificationResults.set(correlationId, result);
    return result;
  }

  /**
   * 依存関係の完全性を検証する（循環依存チェック）
   */
  verifyNoCircularDependencies() {
    const visited = new Set();
    const recursionStack = new Set();

    const hasCycle = (node) => {
      visited.add(node);
      recursionStack.add(node);

      const dependencies = this.dependencies.get(node) || [];
      for (const dep of dependencies) {
        if (!visited.has(dep)) {
          if (hasCycle(dep)) {
            return true;
          }
        } else if (recursionStack.has(dep)) {
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    for (const componentId of this.dependencies.keys()) {
      visited.clear();
      recursionStack.clear();
      if (hasCycle(componentId)) {
        return {
          valid: false,
          reason: `Circular dependency detected involving ${componentId}`
        };
      }
    }

    return { valid: true, reason: 'No circular dependencies' };
  }

  /**
   * 依存関係グラフを取得する
   */
  getDependencyGraph() {
    const graph = {};
    for (const [componentId, dependsOn] of this.dependencies.entries()) {
      graph[componentId] = dependsOn;
    }
    return graph;
  }

  getVerificationResult(correlationId) {
    return this.verificationResults.get(correlationId) || null;
  }
}

class RemediationAdvisor {
  constructor(options = {}) {
    this.remediationRules = new Map(); // issueType -> remediation steps
    this.recommendations = new Map(); // correlationId -> recommendation
  }

  /**
   * 修復ルールを定義する
   * @param {string} issueType - 問題タイプ
   * @param {object} rule - 修復ルール
   */
  defineRemediationRule(issueType, rule) {
    if (!issueType || typeof issueType !== 'string') {
      throw new Error('Invalid issueType');
    }
    if (!rule || typeof rule !== 'object') {
      throw new Error('Invalid rule');
    }

    this.remediationRules.set(issueType, {
      issueType,
      description: rule.description,
      steps: rule.steps || [],
      priority: rule.priority || 'medium',
      autoFixable: rule.autoFixable || false,
      requiresApproval: rule.requiresApproval === true
    });

    return { issueType, registered: true };
  }

  /**
   * 問題に対する修復提案を生成する
   * @param {string} issueType - 問題タイプ
   * @param {object} context - コンテキスト
   */
  generateRecommendation(issueType, context = {}) {
    const correlationId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const rule = this.remediationRules.get(issueType);

    if (!rule) {
      const recommendation = {
        correlationId,
        issueType,
        timestamp,
        available: false,
        message: `No remediation rule defined for issue type: ${issueType}`
      };
      this.recommendations.set(correlationId, recommendation);
      return recommendation;
    }

    const recommendation = {
      correlationId,
      issueType,
      timestamp,
      available: true,
      description: rule.description,
      steps: rule.steps,
      priority: rule.priority,
      autoFixable: rule.autoFixable,
      requiresApproval: rule.requiresApproval,
      context,
      estimatedDuration: context.estimatedDuration
    };

    this.recommendations.set(correlationId, recommendation);
    return recommendation;
  }

  /**
   * 複数の問題に対するアクションプランを生成する
   * @param {array} issues - 問題配列
   */
  generateActionPlan(issues) {
    const correlationId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const plan = {
      correlationId,
      timestamp,
      totalIssues: issues.length,
      recommendations: [],
      estimatedDuration: 0,
      requiresApproval: false
    };

    for (const issue of issues) {
      const recommendation = this.generateRecommendation(issue.type, {
        componentId: issue.componentId,
        severity: issue.severity
      });

      plan.recommendations.push(recommendation);

      if (recommendation.autoFixable) {
        plan.autoFixableCount = (plan.autoFixableCount || 0) + 1;
      }
      if (recommendation.requiresApproval) {
        plan.requiresApproval = true;
      }
    }

    return plan;
  }

  getRecommendation(correlationId) {
    return this.recommendations.get(correlationId) || null;
  }

  /**
   * 修復ルール一覧を取得する
   */
  getRules() {
    const rules = [];
    for (const rule of this.remediationRules.values()) {
      rules.push({
        issueType: rule.issueType,
        description: rule.description,
        autoFixable: rule.autoFixable,
        requiresApproval: rule.requiresApproval,
        priority: rule.priority
      });
    }
    return rules;
  }

  getStats() {
    return {
      definedRules: this.remediationRules.size,
      recommendationsGenerated: this.recommendations.size,
      timestamp: new Date().toISOString()
    };
  }
}

class ComprehensiveHealthCheck {
  constructor(options = {}) {
    this.registry = new HealthCheckRegistry(options);
    this.verifier = new DependencyVerifier(options);
    this.advisor = new RemediationAdvisor(options);
  }

  /**
   * フル検査を実行する
   * @param {array} checks - チェック実行関数の配列
   */
  async executeFullCheck(checks) {
    const correlationId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const results = [];

    for (const check of checks) {
      try {
        const result = await check();
        this.registry.recordCheck(result.componentId, result);
        results.push({
          componentId: result.componentId,
          status: result.healthy ? 'passed' : 'failed'
        });
      } catch (error) {
        results.push({
          componentId: check.name || 'unknown',
          status: 'error',
          error: error.message
        });
      }
    }

    const overallStatus = this.registry.getAllStatus();

    return {
      correlationId,
      timestamp,
      results,
      summary: overallStatus.summary,
      overallStatus: overallStatus.summary.overallStatus
    };
  }

  /**
   * 全体的なヘルスレポートを生成する
   */
  generateHealthReport() {
    const timestamp = new Date().toISOString();
    const allStatus = this.registry.getAllStatus();
    const circularCheck = this.verifier.verifyNoCircularDependencies();

    const unhealthyComponents = allStatus.components
      .filter(c => c.status === 'unhealthy');

    const plan = unhealthyComponents.length > 0
      ? this.advisor.generateActionPlan(
          unhealthyComponents.map(c => ({
            type: c.severity || 'error',
            componentId: c.componentId,
            severity: c.severity
          }))
        )
      : null;

    return {
      timestamp,
      health: {
        overallStatus: allStatus.summary.overallStatus,
        totalComponents: allStatus.summary.totalComponents,
        healthyCount: allStatus.summary.healthyCount,
        unhealthyCount: allStatus.summary.unhealthyCount,
        unknownCount: allStatus.summary.unknownCount
      },
      components: allStatus.components,
      dependencies: {
        circular: !circularCheck.valid,
        circularDescription: circularCheck.reason
      },
      issues: unhealthyComponents.map(c => ({
        componentId: c.componentId,
        status: c.status,
        issues: c.issues,
        severity: c.severity
      })),
      actionPlan: plan,
      stats: this.registry.getStats()
    };
  }
}

module.exports = {
  HealthCheckRegistry,
  DependencyVerifier,
  RemediationAdvisor,
  ComprehensiveHealthCheck
};
