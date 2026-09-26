const path = require('node:path');

const DEFAULT_ORIGINS = ['http://localhost:3000'];
const DEFAULT_POWERAPPS_ORG_URL = ''; // Fail closed: explicit CN_AI target required
const DEFAULT_POWERAPPS_SOLUTION = ''; // Never silently select another solution
const CN_AI_TARGET = Object.freeze({
  appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
  environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
  orgUrl: 'https://org0bbb24c5.crm7.dynamics.com',
  solutionUniqueName: 'CN_AIIraiDaicho',
  githubRoot: 'powerapps/CN_AI依頼台帳/Source'
});

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

function assertCnAiTarget(env) {
  const actual = {
    appId: env.POWERAPPS_APP_ID,
    environmentId: env.POWERAPPS_ENVIRONMENT_ID,
    orgUrl: env.POWERAPPS_ORG_URL?.replace(/\/$/, ''),
    solutionUniqueName: env.POWERAPPS_SOLUTION_UNIQUE_NAME,
    githubRoot: env.POWERAPPS_GITHUB_ROOT
  };
  for (const [key, expected] of Object.entries(CN_AI_TARGET)) {
    if (actual[key] !== expected) throw new Error(`CN_AI target mismatch or missing: ${key}`);
  }
  return true;
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
    mcpApiKey: env.MCP_API_KEY || '',
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
      logPath: path.resolve(env.POWERAPPS_LOG_PATH || 'data/powerapps-operations.jsonl'),
      orgUrl: env.POWERAPPS_ORG_URL || DEFAULT_POWERAPPS_ORG_URL,
      solutionUniqueName: env.POWERAPPS_SOLUTION_UNIQUE_NAME || DEFAULT_POWERAPPS_SOLUTION,
      githubToken: env.POWERAPPS_GITHUB_TOKEN || '',
      githubOwner: env.POWERAPPS_GITHUB_OWNER || 'oohiraplas-cpu',
      githubRepo: env.POWERAPPS_GITHUB_REPO || 'clean-nano-ai-bridge',
      githubBranch: env.POWERAPPS_GITHUB_BRANCH || 'main',
      githubRoot: env.POWERAPPS_GITHUB_ROOT || ''
    },
    powerAutomate: {
      flows: parsePowerAutomateFlows(env.POWER_AUTOMATE_FLOWS)
    }
  };
}

module.exports = { getConfig, assertCnAiTarget, CN_AI_TARGET };
