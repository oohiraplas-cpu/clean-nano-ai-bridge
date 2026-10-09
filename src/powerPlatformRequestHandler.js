/**
 * execute_powerplatform_request: 統合MCP エントリポイント
 * ユーザーの短文1回から、Power Platform全体を一気通貫で制御
 */

const crypto = require('node:crypto');
const { PlatformOrchestrator } = require('./platformOrchestrator');
const {
  PowerAppsExecutionAdapter,
  SharePointExecutionAdapter,
  PowerAutomateExecutionAdapter,
  CopilotStudioExecutionAdapter,
  GitHubExecutionAdapter,
  AzureExecutionAdapter
} = require('./executionAdapters');
const {
  ApprovalPolicy,
  DataPolicy,
  ValidationPolicy,
  AuditLog,
  RollbackManager,
  EfficiencyMetrics
} = require('./commonPolicies');

/**
 * Power Platform Request Handler: 統合実行制御
 */
class PowerPlatformRequestHandler {
  constructor({
    powerAppsStore,
    powerAppsGitStore,
    sharePointReader,
    powerAutomateRunner,
    stateRegistry,
    deploymentService,
    permissionsService,
    config
  }) {
    // 実行アダプター初期化
    this.adapters = {
      powerApps: new PowerAppsExecutionAdapter({
        powerAppsStore,
        powerAppsGitStore,
        stateRegistry,
        config
      }),
      sharePoint: new SharePointExecutionAdapter({
        sharePointReader,
        config
      }),
      powerAutomate: new PowerAutomateExecutionAdapter({
        powerAutomateRunner,
        config
      }),
      copilotStudio: new CopilotStudioExecutionAdapter({
        config
      }),
      github: new GitHubExecutionAdapter({
        powerAppsGitStore,
        config
      }),
      azure: new AzureExecutionAdapter({
        deploymentService,
        config
      })
    };

    // 共通ポリシー初期化
    this.approvalPolicy = new ApprovalPolicy(null);
    this.auditLog = new AuditLog();
    this.rollbackManager = new RollbackManager();
    this.efficiencyMetrics = new EfficiencyMetrics();

    // Orchestrator初期化
    this.orchestrator = new PlatformOrchestrator({
      powerAppsStore,
      powerAppsGitStore,
      sharePointReader,
      powerAutomateRunner,
      stateRegistry,
      deploymentService,
      permissionsService,
      config
    });

    this.config = config;
    this.stateRegistry = stateRegistry;
  }

  /**
   * 統合実行エントリポイント
   * 入力:
   * {
   *   "request": "ユーザー短文",
   *   "targetName": "optional",
   *   "targetId": "optional",
   *   "environmentId": "optional",
   *   "requestId": "optional",
   *   "approvalToken": "optional",
   *   "publishApproval": false
   * }
   */
  async executePowerPlatformRequest(input) {
    const requestId = input.requestId || crypto.randomUUID();
    const startTime = Date.now();

    // ユーザー入力回数: 1
    this.efficiencyMetrics.record(requestId, 'userInputs', 1);

    // Step 1: 入力検証
    const validation = this._validateInput(input);
    if (!validation.valid) {
      return this._returnBlocked(validation.error, validation.errors, requestId);
    }

    // Step 2: 秘密値検査
    const secrets = DataPolicy.detectSecrets(input.request);
    if (secrets.length > 0) {
      return this._returnBlocked(
        '秘密情報が入力に含まれています',
        secrets.map(s => `${s.type}が含まれています`),
        requestId
      );
    }

    // Step 3: 推測・模擬データ検査
    const speculations = DataPolicy.detectSpeculation(input.request);
    if (speculations.length > 0) {
      return this._returnBlocked(
        '推測・模擬データが含まれています',
        speculations.map(s => `${s.value}: 確認が必要です`),
        requestId
      );
    }

    // Step 4: Orchestrator実行
    try {
      const result = await this.orchestrator.executePowerPlatformRequest({
        request: input.request,
        targetName: input.targetName,
        targetId: input.targetId,
        environmentId: input.environmentId,
        requestId,
        approvalToken: input.approvalToken,
        publishApproval: input.publishApproval || false
      });

      // Step 5: 監査ログ記録
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      this.efficiencyMetrics.record(requestId, 'elapsedSeconds', elapsedSeconds);

      this.auditLog.log({
        requestId,
        timestamp: new Date().toISOString(),
        actor: 'system',
        action: 'execute_powerplatform_request',
        resource: input.targetName || input.targetId || 'unknown',
        resourceType: 'powerplatform',
        changes: result.executionPlan?.changes || 0,
        status: result.conclusion === 'DONE' || result.conclusion === 'SAVED' ? 'success' : 'failure',
        result: result.conclusion,
        errors: result.unresolved
      });

      // Step 6: 効率指標追加
      result.efficiency = {
        ...result.efficiency,
        ...this.efficiencyMetrics.aggregate(requestId)
      };

      return result;
    } catch (error) {
      this.auditLog.log({
        requestId,
        timestamp: new Date().toISOString(),
        actor: 'system',
        action: 'execute_powerplatform_request',
        status: 'failure',
        errors: [error.message]
      });

      return this._returnBlocked(`実行エラー: ${error.message}`, [error.message], requestId);
    }
  }

  /**
   * 入力検証
   */
  _validateInput(input) {
    if (input === null || input === undefined) {
      return { valid: false, error: '入力がnullまたはundefinedです', errors: [] };
    }
    if (typeof input !== 'object') {
      return { valid: false, error: '入力がオブジェクトではありません', errors: [] };
    }

    if (!input.request || typeof input.request !== 'string' || input.request.trim().length === 0) {
      return { valid: false, error: 'requestフィールドが空です', errors: [] };
    }

    if (input.request.length > 5000) {
      return { valid: false, error: 'requestが長すぎます（最大5000文字）', errors: [] };
    }

    return { valid: true };
  }

  /**
   * ブロック結果返却
   */
  _returnBlocked(reason, errors, requestId) {
    return {
      conclusion: 'BLOCKED',
      reason,
      errors,
      requestId,
      unresolved: errors,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 監査ログ取得
   */
  getAuditTrail(requestId) {
    return this.auditLog.generateAuditTrail(requestId);
  }

  /**
   * ロールバック実行
   */
  async rollback(requestId, approvalToken) {
    if (!approvalToken) {
      return { success: false, error: 'ロールバックには承認トークンが必要です' };
    }

    return this.rollbackManager.rollback(requestId, this.adapters);
  }
}

/**
 * MCP Tool: execute_powerplatform_request
 */
function validateExecutePowerPlatformRequestParams(params) {
  if (!params || typeof params !== 'object') {
    return 'paramsはJSONオブジェクトである必要があります';
  }

  if (!params.request || typeof params.request !== 'string') {
    return 'requestは文字列が必要です';
  }

  if (params.targetName !== undefined && typeof params.targetName !== 'string') {
    return 'targetNameは文字列が必要です';
  }

  if (params.targetId !== undefined && typeof params.targetId !== 'string') {
    return 'targetIdは文字列が必要です';
  }

  if (params.environmentId !== undefined && typeof params.environmentId !== 'string') {
    return 'environmentIdは文字列が必要です';
  }

  if (params.requestId !== undefined && typeof params.requestId !== 'string') {
    return 'requestIdは文字列が必要です';
  }

  if (params.approvalToken !== undefined && typeof params.approvalToken !== 'string') {
    return 'approvalTokenは文字列が必要です';
  }

  if (params.publishApproval !== undefined && typeof params.publishApproval !== 'boolean') {
    return 'publishApprovalはbooleanが必要です';
  }

  return null;
}

module.exports = {
  PowerPlatformRequestHandler,
  validateExecutePowerPlatformRequestParams
};
