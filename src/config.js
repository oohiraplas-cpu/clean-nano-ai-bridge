const path = require('node:path');

const DEFAULT_ORIGINS = ['http://localhost:3000'];
const CN_AI_APP_ID = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e';
const CN_AI_ENVIRONMENT_ID = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const CN_AI_ORG_URL = 'https://org0bbb24c5.crm7.dynamics.com';
const CN_AI_SOLUTION = 'CN_AIIraiDaicho';
const CN_AI_BRANCH = 'fix/cn-aiiraidaicho-safe-export-20260926';
const CN_AI_ROOT = 'powerapps/CN_AI依頼台帳/Source';

function parsePowerAutomateFlows(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getConfig(env = process.env) {
  const origins = (env.CORS_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  // This isolated deployment is exclusively for CN_AI依頼台帳.
  // It does not modify CN_CompanyOS and does not enable Power Apps save/publish.
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
      environmentId: CN_AI_ENVIRONMENT_ID,
      appId: CN_AI_APP_ID,
      sourceAppId: CN_AI_APP_ID,
      sourceEnvironmentId: CN_AI_ENVIRONMENT_ID,
      logPath: path.resolve(env.POWERAPPS_LOG_PATH || 'data/powerapps-operations.jsonl'),
      orgUrl: CN_AI_ORG_URL,
      solutionUniqueName: CN_AI_SOLUTION,
      githubToken: env.POWERAPPS_GITHUB_TOKEN || '',
      githubOwner: 'oohiraplas-cpu',
      githubRepo: 'clean-nano-ai-bridge',
      githubBranch: CN_AI_BRANCH,
      githubRoot: CN_AI_ROOT
    },
    powerAutomate: {
      flows: parsePowerAutomateFlows(env.POWER_AUTOMATE_FLOWS)
    }
  };
}

module.exports = { getConfig };
