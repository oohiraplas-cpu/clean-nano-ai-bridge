const path = require('node:path');

const DEFAULT_ORIGINS = ['http://localhost:3000'];
const DEFAULT_POWERAPPS_ORG_URL = 'https://orgcf455a58.crm7.dynamics.com';
const DEFAULT_POWERAPPS_SOLUTION = 'CN_CompanyOS';

// POWER_AUTOMATE_FLOWSはJSON文字列（{"flowKey": "トリガーURL"}）としてのみ環境変数で渡す。
// パース不能・未設定の場合は空オブジェクト扱いとし、起動を落とさない。
function parsePowerAutomateFlows(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseCsv(value, fallback = []) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// MCP 認証鍵の解決。正式名 CN_MCP_API_KEY を最優先し、未設定時のみ後方互換の MCP_API_KEY を使う。
// 戻り値は値そのものを含むため、ログ・応答・監査へ出してはならない（出すのは source のみ）。
function resolveMcpApiKey(env = process.env) {
  if (env.CN_MCP_API_KEY) return { key: env.CN_MCP_API_KEY, source: 'CN_MCP_API_KEY' };
  if (env.MCP_API_KEY) return { key: env.MCP_API_KEY, source: 'MCP_API_KEY' };
  return { key: '', source: null };
}

function getConfig(env = process.env) {
  const origins = (env.CORS_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  return {
    port: Number.parseInt(env.PORT || '3000', 10),
    host: env.HOST || '0.0.0.0',
    nodeEnv: env.NODE_ENV || 'development',
    corsOrigins: origins,
    tasksFile: path.resolve(env.TASKS_FILE || 'data/tasks.json'),
    webhookApiKey: env.WEBHOOK_API_KEY || '',
    // 認証鍵の正式名は CN_MCP_API_KEY。後方互換として MCP_API_KEY を読む。値はログ・応答に出さない。
    mcpApiKey: resolveMcpApiKey(env).key,
    // 変数名のみを保持する（値は保持しない）。authentication_check が有効な変数名を示すために使う。
    mcpApiKeySource: resolveMcpApiKey(env).source,
    // Microsoft Graph（SharePoint READ）の認証材料。値は内部保持のみで、応答・ログ・監査へ出さない。
    graphAuth: {
      identityEndpoint: env.IDENTITY_ENDPOINT || '',
      identityHeader: env.IDENTITY_HEADER || '',
      certificate: { tenantId: env.GRAPH_CERT_TENANT_ID || '', clientId: env.GRAPH_CERT_CLIENT_ID || '', thumbprint: env.GRAPH_CERT_THUMBPRINT || '' },
      delegated: { tenantId: env.GRAPH_DELEGATED_TENANT_ID || '', clientId: env.GRAPH_DELEGATED_CLIENT_ID || '' }
    },
    // Clean Nano Operations の一時ストレージ（JSON Lines）。未設定ならメモリ上に保持する。
    operations: { storeFile: env.OPERATIONS_STORE_FILE ? path.resolve(env.OPERATIONS_STORE_FILE) : '' },
    // Separate, read-only key for the claude.ai connector endpoint (/connector/mcp). Empty disables the endpoint.
    connectorApiKey: env.CONNECTOR_API_KEY || '',
    stateContextRegistry: {
      ttlMs: Math.max(1, parsePositiveInt(env.STATE_CONTEXT_TTL_MS, 300000)),
      maxEntries: Math.max(1, parsePositiveInt(env.STATE_CONTEXT_MAX_ENTRIES, 1000))
    },
    taskStoreBackend: env.TASK_STORE_BACKEND || 'file',
    sharepoint: {
      tenantId: env.SHAREPOINT_TENANT_ID || env.AZURE_TENANT_ID || '',
      clientId: env.SHAREPOINT_CLIENT_ID || env.AZURE_CLIENT_ID || '',
      clientSecret: env.SHAREPOINT_CLIENT_SECRET || env.AZURE_CLIENT_SECRET || '',
      siteId: env.SHAREPOINT_SITE_ID || '',
      listId: env.SHAREPOINT_LIST_ID || '',
      employeeLedgerListId: env.SHAREPOINT_EMPLOYEE_LEDGER_LIST_ID || ''
    },
    powerApps: {
      tenantId: env.POWERAPPS_TENANT_ID || env.AZURE_TENANT_ID || '',
      clientId: env.POWERAPPS_CLIENT_ID || env.AZURE_CLIENT_ID || '',
      clientSecret: env.POWERAPPS_CLIENT_SECRET || env.AZURE_CLIENT_SECRET || '',
      environmentId: env.POWERAPPS_ENVIRONMENT_ID || '',
      appId: env.POWERAPPS_APP_ID || '',
      runtimeSource: {
        mode: env.POWERAPPS_RUNTIME_SOURCE_ADAPTER || '',
        authMode: env.POWERAPPS_RUNTIME_AUTH_MODE || '',
        managedIdentityClientId: env.POWERAPPS_RUNTIME_MI_CLIENT_ID || null,
        pacProfileHome: env.POWERAPPS_RUNTIME_PAC_PROFILE_HOME || '',
        pythonExecutable: env.POWERAPPS_RUNTIME_PYTHON || 'python3',
        pacExecutable: env.POWERAPPS_RUNTIME_PAC || 'pac',
        sourceMap: parsePowerAutomateFlows(env.POWERAPPS_RUNTIME_SOURCE_MAP)
      },
      logPath: path.resolve(env.POWERAPPS_LOG_PATH || 'data/powerapps-operations.jsonl'),
      orgUrl: env.POWERAPPS_ORG_URL || DEFAULT_POWERAPPS_ORG_URL,
      solutionUniqueName: env.POWERAPPS_SOLUTION_UNIQUE_NAME || DEFAULT_POWERAPPS_SOLUTION,
      githubToken: env.POWERAPPS_GITHUB_TOKEN || '',
      githubOwner: env.POWERAPPS_GITHUB_OWNER || 'oohiraplas-cpu',
      githubRepo: env.POWERAPPS_GITHUB_REPO || 'clean-nano-ai-bridge',
      githubBranch: env.POWERAPPS_GITHUB_BRANCH || 'main',
      githubRoot: env.POWERAPPS_GITHUB_ROOT || 'powerapps/CN_AI依頼台帳/Source',
      githubFallbackBranches: (env.POWERAPPS_GITHUB_FALLBACK_BRANCHES || 'sync/cn-aiiraidaicho-live-review-20260926,main').split(',').map((v) => v.trim()).filter(Boolean),
      githubFallbackRoots: (env.POWERAPPS_GITHUB_FALLBACK_ROOTS || 'powerapps/CN_AI依頼台帳/Source').split(',').map((v) => v.trim()).filter(Boolean),
      azureDevOps: {
        organization: env.POWERAPPS_AZDO_ORGANIZATION || '',
        project: env.POWERAPPS_AZDO_PROJECT || '',
        repository: env.POWERAPPS_AZDO_REPOSITORY || '',
        branch: env.POWERAPPS_AZDO_BRANCH || 'main',
        root: (env.POWERAPPS_AZDO_ROOT || '').replace(/^\/+|\/+$/g, ''),
        pat: env.POWERAPPS_AZDO_PAT || ''
      }
    },
    powerAutomate: {
      flows: parsePowerAutomateFlows(env.POWER_AUTOMATE_FLOWS)
    },
    // デプロイ連携（deploy_to_test / verify_deployment / get_deployment_logs / rollback_deployment）。
    // 未設定の項目があるツールは、ダミー成功にせずstatus:'not_configured'で拒否する。
    // GitHubトークンはPower Appsソース用(POWERAPPS_GITHUB_TOKEN)とは別に、最小権限のものを用意する。
    deployment: {
      githubToken: env.DEPLOY_GITHUB_TOKEN || '',
      githubOwner: env.DEPLOY_GITHUB_OWNER || env.POWERAPPS_GITHUB_OWNER || 'oohiraplas-cpu',
      githubRepo: env.DEPLOY_GITHUB_REPO || env.POWERAPPS_GITHUB_REPO || 'clean-nano-ai-bridge',
      allowedBranches: parseCsv(env.DEPLOY_ALLOWED_BRANCHES, [env.POWERAPPS_GITHUB_BRANCH || 'main']),
      testWorkflow: env.DEPLOY_TEST_WORKFLOW || '',
      testEnvironmentName: env.DEPLOY_TEST_ENVIRONMENT_NAME || '',
      testBaseUrl: (env.DEPLOY_TEST_BASE_URL || '').replace(/\/+$/, ''),
      productionWorkflow: env.DEPLOY_PRODUCTION_WORKFLOW || '',
      productionEnvironmentName: env.DEPLOY_PRODUCTION_ENVIRONMENT_NAME || '',
      productionBaseUrl: (env.DEPLOY_PRODUCTION_BASE_URL || '').replace(/\/+$/, ''),
      historyPath: path.resolve(env.DEPLOY_HISTORY_PATH || 'data/deployments.jsonl'),
      healthAttempts: Math.max(1, parsePositiveInt(env.DEPLOY_HEALTH_ATTEMPTS, 3)),
      healthRetryDelayMs: parsePositiveInt(env.DEPLOY_HEALTH_RETRY_DELAY_MS, 5000)
    },
    // 権限管理（get_permissions / update_permissions）。許可リストが空の場合、付与系は未構成として拒否する。
    permissions: {
      allowedPrincipalDomains: parseCsv(env.PERMISSIONS_ALLOWED_PRINCIPAL_DOMAINS).map((value) => value.toLowerCase()),
      allowedDataverseRoles: parseCsv(env.PERMISSIONS_ALLOWED_DATAVERSE_ROLES)
    },
    // Phase 6: State Manager Enforcement (Fail-Closed)
    // When enabled (set BRIDGE_STATE_MANAGER_ENFORCE=true), all write operations require
    // complete state context (appId, environment, branch, sha, correlationId).
    // Default: false (for backward compatibility during testing/migration)
    // Commit SHA the running Bridge was deployed from (set by the deploy workflow).
    deploymentSha: env.DEPLOYMENT_SHA || null,
    enforceStateManager: env.BRIDGE_STATE_MANAGER_ENFORCE === 'true'
  };
}

module.exports = { getConfig, resolveMcpApiKey };
