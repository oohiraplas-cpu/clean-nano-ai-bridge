/**
 * Bridge Capabilities Service
 * 
 * Bridge の能力情報、依存先health、差分比較、ソース検証を提供
 */

const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { compareSources } = require('./sourceComparison');
const { sourceUnavailable, validationBlocked } = require('./powerAppsRuntimeSource');

/**
 * 共通レスポンス構造を構築
 * @param {Object} options
 * @returns {Object} 共通レスポンス
 */
function createCommonResponse(options = {}) {
  const {
    status = 'ok',
    data = {},
    correlationId = crypto.randomUUID(),
    operationId = null,
    verified = false,
    summary = null,
    warnings = [],
    unconfirmed = [],
    errors = [],
    approvalRequired = false,
    rollbackPoint = null,
    auditReference = null
  } = options;

  return {
    accepted: true,
    status,
    correlationId,
    operationId: operationId || crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    verified,
    summary: summary || status,
    data,
    warnings,
    unconfirmed,
    errors,
    approvalRequired,
    rollbackPoint,
    auditReference
  };
}

/**
 * Bridge の能力情報を取得
 * Version, MCP仕様, 公開ツール, 制約情報を返す
 */
function getBridgeCapabilities(MCP_PUBLIC_TOOLS, {
  version = '1.0.0',
  mcpVersion = '2025-06-18',
  schemaVersion = '2025-10-10',
  deploymentSha = null,
  executionPackageVersion = '1.0.0',
  supportedStateContextFields = ['appId', 'environment', 'branch', 'canonicalBranch', 'sha', 'correlationId']
} = {}) {
  const capabilities = {
    bridge: {
      version,
      name: 'clean-nano-ai-bridge',
      description: 'Power Apps/SharePoint/Power Automate/Git管理用MCP',
      schemaVersion,
      deploymentSha,
      executionPackageVersion,
      supportedStateContextFields
    },
    mcp: {
      version: mcpVersion,
      protocolSupport: ['JSON-RPC 2.0'],
      supportedMethods: ['initialize', 'tools/list', 'tools/call', 'ping']
    },
    tools: {
      count: MCP_PUBLIC_TOOLS.length,
      list: MCP_PUBLIC_TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        category: categorizeTool(tool.name),
        readOnly: isReadOnlyTool(tool.name),
        requiresApproval: requiresApprovalTool(tool.name),
        hasInputSchema: !!tool.inputSchema,
        hasComplexity: !['health_check', 'get_tasks', 'get_next_task'].includes(tool.name)
      }))
    },
    executivePolicy: JSON.parse(JSON.stringify(require('./executivePolicy.json'))),
    constraints: {
      maxRequestSize: '256KB',
      readOnlyTools: [
        'health_check',
        'get_tasks',
        'get_next_task',
        'get_task_result',
        'get_powerapps_app',
        'get_powerapps_state',
        'get_powerapps_source',
        'get_powerapps_operation_result',
        'get_sharepoint_list',
        'get_sharepoint_columns',
        'get_permissions',
        'get_deployment_logs'
      ],
      approvalRequiredActions: [
        'publish_powerapps_app',
        'run_power_automate_flow',
        'update_employee_ledger_entry',
        'rollback_deployment',
        'update_permissions'
      ],
      cannotUseFeatures: [
        'Premium Connectors',
        'AI Builder',
        'Dataverse',
        'External Premium SKUs'
      ]
    },
    security: {
      authenticationMethod: 'API Key (X-API-Key)',
      secretsManagement: 'Azure App Settings',
      secretsNeverReturned: true,
      timingSafeComparison: true
    }
  };

  return createCommonResponse({
    status: 'ok',
    data: capabilities,
    summary: `Bridge v${version} ready with ${MCP_PUBLIC_TOOLS.length} tools`,
    verified: true
  });
}

/**
 * ツール名からカテゴリを判定
 */
function categorizeTool(toolName) {
  if (toolName.startsWith('health_') || toolName === 'check_dependencies') return 'monitoring';
  if (toolName.startsWith('get_') && !toolName.includes('powerapps') && !toolName.includes('sharepoint')) return 'management';
  if (toolName.startsWith('get_powerapps_') || toolName.startsWith('update_powerapps_') || toolName.startsWith('publish_')) return 'power-apps';
  if (toolName.startsWith('get_sharepoint_') || toolName.startsWith('ensure_sharepoint_') || toolName.startsWith('create_employee')) return 'sharepoint';
  if (toolName.includes('power_automate')) return 'power-automate';
  if (toolName.includes('deployment') || toolName.includes('git')) return 'deployment';
  if (toolName.includes('permissions')) return 'security';
  return 'other';
}

/**
 * ツールが読み取り専用か判定
 */
function isReadOnlyTool(toolName) {
  return [
    'get_executive_policy', 'get_executive_brief',
    'health_check',
    'get_tasks',
    'get_next_task',
    'get_task_result',
    'get_powerapps_app',
    'get_powerapps_state',
    'get_powerapps_source',
    'get_powerapps_operation_result',
    'get_sharepoint_list',
    'get_sharepoint_columns',
    'get_permissions',
    'get_deployment_logs',
    'check_dependencies'
  ].includes(toolName);
}

/**
 * ツールが人間承認を必須とするか判定
 */
function requiresApprovalTool(toolName) {
  return [
    'publish_powerapps_app',
    'run_power_automate_flow',
    'update_employee_ledger_entry',
    'create_employee_ledger_entry',
    'rollback_deployment',
    'update_permissions'
  ].includes(toolName);
}

/**
 * 依存先の health を確認
 * Power Apps, SharePoint, Power Automate, Git, Azure の状態をチェック
 */
async function checkDependencies(options = {}) {
  const {
    powerAppsStore,
    sharePointReader,
    powerAutomateRunner,
    powerAppsGitStore
  } = options;

  const results = {
    bridge: { status: 'ok' },
    dependencies: {}
  };
  const errors = [];
  const warnings = [];
  const unconfirmed = [];

  // Power Apps health
  try {
    if (powerAppsStore && powerAppsStore.getAppState) {
      const appState = await powerAppsStore.getAppState();
      results.dependencies.powerApps = {
        status: appState?.id ? 'ok' : 'warning',
        appId: appState?.id || 'unknown',
        lastModified: appState?.lastModifiedTime
      };
    } else {
      results.dependencies.powerApps = { status: 'not_configured' };
      warnings.push('Power Apps Store未構成');
    }
  } catch (error) {
    results.dependencies.powerApps = { status: 'error', message: error.message };
    errors.push(`Power Apps health check failed: ${error.message}`);
  }

  // SharePoint health
  try {
    if (sharePointReader && sharePointReader.healthCheck) {
      const spHealth = await sharePointReader.healthCheck?.();
      results.dependencies.sharePoint = { status: spHealth?.ok ? 'ok' : 'error' };
    } else {
      results.dependencies.sharePoint = { status: 'not_configured' };
      warnings.push('SharePoint Reader未構成');
    }
  } catch (error) {
    results.dependencies.sharePoint = { status: 'error', message: error.message };
    errors.push(`SharePoint health check failed: ${error.message}`);
  }

  // Power Automate health
  try {
    if (powerAutomateRunner && powerAutomateRunner.healthCheck) {
      const flowHealth = await powerAutomateRunner.healthCheck?.();
      results.dependencies.powerAutomate = { status: flowHealth?.ok ? 'ok' : 'error' };
    } else {
      results.dependencies.powerAutomate = { status: 'not_configured' };
      warnings.push('Power Automate Runner未構成');
    }
  } catch (error) {
    results.dependencies.powerAutomate = { status: 'error', message: error.message };
    errors.push(`Power Automate health check failed: ${error.message}`);
  }

  // Git health
  try {
    if (powerAppsGitStore && powerAppsGitStore.healthCheck) {
      const gitHealth = await powerAppsGitStore.healthCheck?.();
      results.dependencies.git = { status: gitHealth?.ok ? 'ok' : 'error', branch: gitHealth?.branch };
    } else {
      results.dependencies.git = { status: 'not_configured' };
      warnings.push('Git Store未構成');
    }
  } catch (error) {
    results.dependencies.git = { status: 'error', message: error.message };
    errors.push(`Git health check failed: ${error.message}`);
  }

  // Overall status determination
  const overallStatus = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ok';
  const allHealthy = errors.length === 0 && warnings.length === 0;

  return createCommonResponse({
    status: overallStatus,
    data: results,
    verified: allHealthy,
    warnings,
    errors,
    summary: allHealthy
      ? 'All dependencies healthy'
      : `${errors.length} error(s), ${warnings.length} warning(s)`,
    unconfirmed: unconfirmed.length > 0 ? unconfirmed : undefined
  });
}

/**
 * Power Apps と Git の差分を比較
 * 一致、Power Apps側が新しい、Git側が新しい、競合等の状態を判定
 */
async function comparePowerAppsWithGit(options = {}) {
  const { powerAppsStore, powerAppsGitStore, targetFile = null } = options;
  const comparison = {
    powerApps: {}, git: {}, status: 'unknown', details: {}, hasDifferences: null,
    targetSha: options.gitSource?.sha || null,
    comparisonSources: { powerApps: 'power-apps-runtime', git: 'github-canonical' }
  };
  // Preserve the historical diagnostic fields while explicitly refusing parity.
  if (typeof powerAppsStore?.getSourceFile !== 'function') {
    comparison.status = 'unconfirmed';
    comparison.comparisonStatus = 'source_unavailable';
    comparison.powerApps = { exists: null, source: 'power-apps-runtime', reason: 'source_reader_unavailable' };
    comparison.git = { exists: Boolean(options.gitSource), file: options.gitSource?.path,
      branch: options.gitSource?.branch, sha: options.gitSource?.sha, source: 'git' };
    return { ...createCommonResponse({ status: 'error', data: comparison, verified: false,
      errors: ['Power Apps runtime source reader is unavailable'],
      unconfirmed: ['Power Apps runtime source content'], summary: 'Comparison unconfirmed' }),
      comparisonStatus: 'source_unavailable' };
  }
  let runtime, git;
  try {
    runtime = await powerAppsStore.getSourceFile(targetFile, {
      stateContext: options.stateContext, assertStateContext: options.assertStateContext
    });
    git = options.gitSource || await powerAppsGitStore.getSourceFile(targetFile);
  } catch (error) {
    if (error.payload?.comparisonStatus || error.payload?.status === 'state_context_invalid') throw error;
    // Upstream errors may contain URLs, credentials, CLI output or source text.
    throw sourceUnavailable('source_read_failed');
  }
  if (typeof runtime?.content !== 'string' || typeof git?.content !== 'string') throw sourceUnavailable('source_content_missing');
  let diff;
  try { diff = compareSources(git.content, runtime.content, targetFile); }
  catch { throw validationBlocked(['sourceContent: invalid YAML or complexity limit']); }
  Object.assign(comparison, diff);
  comparison.status = diff.hasDifferences ? 'diverged' : 'in_sync';
  comparison.details = { match: !diff.hasDifferences, presentationOnly: diff.presentationOnly };
  comparison.powerApps = { exists: true, file: targetFile,
    hash: crypto.createHash('sha256').update(runtime.content).digest('hex'),
    lastModified: runtime.lastModified, source: runtime.source || 'power-apps',
    format: runtime.format, encoding: runtime.encoding };
  comparison.git = { exists: true, file: targetFile, branch: git.branch, sha: git.sha,
    hash: crypto.createHash('sha256').update(git.content).digest('hex'), lastCommit: git.commit, source: 'git' };
  return { ...createCommonResponse({ status: diff.hasDifferences ? 'warning' : 'ok',
    data: comparison, verified: !diff.hasDifferences,
    warnings: diff.hasDifferences ? ['Power Apps and Git source properties differ'] : [],
    summary: comparison.status }), comparisonStatus: diff.comparisonStatus,
    comparisonVerified: true };
}

/**
 * Power Apps ソースの検査
 * 構文、画面名、コントロール、Power Fx参照等を検証
 */
async function validatePowerAppsSource(options = {}) {
  const {
    sourceContent,
    relativePath,
    powerAppsGitStore
  } = options;

  const validation = {
    valid: true,
    checks: {},
    issues: []
  };
  const errors = [];
  const warnings = [];

  try {
    // 1. JSON/YAML 構文チェック
    try {
      if (relativePath?.endsWith('.yaml') || relativePath?.endsWith('.yml')) {
        if (typeof sourceContent !== 'string' || !sourceContent.trim()) throw new Error('Empty YAML source');
        yaml.load(sourceContent, { schema: yaml.JSON_SCHEMA });
        validation.checks.yamlSyntax = {
          status: 'ok',
          valid: true
        };
      } else if (relativePath?.endsWith('.json')) {
        JSON.parse(sourceContent);
        validation.checks.jsonSyntax = { status: 'ok', valid: true };
      } else {
        validation.checks.syntaxCheck = { status: 'unsupported_format' };
      }
    } catch (error) {
      validation.valid = false;
      validation.checks.syntaxCheck = { status: 'error', message: error.message };
      errors.push(`Syntax error: ${error.message}`);
    }

    // 2. Secret 混入チェック
    const secretPatterns = [
      /password\s*[:=]\s*[^\s]*/gi,
      /secret\s*[:=]\s*[^\s]*/gi,
      /token\s*[:=]\s*[^\s]*/gi,
      /api[_-]?key\s*[:=]\s*[^\s]*/gi,
      /Bearer\s+[A-Za-z0-9._-]+/g,
      /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g  // JWT-like
    ];

    const secretMatches = secretPatterns.reduce((acc, pattern) => {
      const matches = sourceContent.match(pattern) || [];
      return [...acc, ...matches];
    }, []);

    if (secretMatches.length > 0) {
      validation.valid = false;
      validation.checks.secretCheck = { status: 'error', found: secretMatches.length };
      errors.push(`Found ${secretMatches.length} potential secrets in source`);
    } else {
      validation.checks.secretCheck = { status: 'ok', found: 0 };
    }

    // 3. ファイルサイズチェック
    const sizeKB = Buffer.byteLength(sourceContent) / 1024;
    validation.checks.fileSize = { status: 'ok', sizeKB };
    if (sizeKB > 1000) {
      warnings.push(`File is large (${sizeKB.toFixed(1)}KB) - may cause performance issues`);
    }

    // 4. 要件別チェック（対象ファイルに応じて）
    if (relativePath?.includes('Screen')) {
      validation.checks.screenValidation = {
        status: 'requires_runtime_validation',
        note: 'Screen validation requires Power Platform runtime - skipped here'
      };
      warnings.push('Screen structure validation deferred to runtime');
    }

    // 5. Branch 確認（提供された場合）
    if (options.expectedBranch && powerAppsGitStore) {
      const canonicalBranch = powerAppsGitStore.canonicalBranch;
      if (options.expectedBranch !== canonicalBranch) {
        validation.valid = false;
        validation.checks.branchCheck = {
          status: 'error',
          expected: canonicalBranch,
          provided: options.expectedBranch
        };
        errors.push(`Branch mismatch: expected ${canonicalBranch}, got ${options.expectedBranch}`);
      } else {
        validation.checks.branchCheck = { status: 'ok', branch: canonicalBranch };
      }
    }

    return createCommonResponse({
      status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ok',
      data: validation,
      verified: validation.valid && errors.length === 0,
      warnings,
      errors,
      summary: validation.valid ? 'Validation passed' : 'Validation failed',
      unconfirmed: warnings.length > 0 ? warnings : undefined
    });
  } catch (error) {
    errors.push(error.message);
    return createCommonResponse({
      status: 'error',
      data: validation,
      verified: false,
      errors,
      summary: `Validation error: ${error.message}`
    });
  }
}

module.exports = {
  createCommonResponse,
  getBridgeCapabilities,
  checkDependencies,
  comparePowerAppsWithGit,
  validatePowerAppsSource
};
