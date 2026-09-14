const path = require('node:path');

const DEFAULT_ORIGINS = ['http://localhost:3000'];

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
    // 'file' (default, data/tasks.json) or 'sharepoint' (SharePoint Listsを正本にする場合)
    taskStoreBackend: env.TASK_STORE_BACKEND || 'file',
    sharepoint: {
      tenantId: env.SHAREPOINT_TENANT_ID || '',
      clientId: env.SHAREPOINT_CLIENT_ID || '',
      clientSecret: env.SHAREPOINT_CLIENT_SECRET || '',
      siteId: env.SHAREPOINT_SITE_ID || '',
      listId: env.SHAREPOINT_LIST_ID || ''
    },
    // Power Apps統合設定
    powerApps: {
      tenantId: env.POWERAPPS_TENANT_ID || '',
      clientId: env.POWERAPPS_CLIENT_ID || '',
      clientSecret: env.POWERAPPS_CLIENT_SECRET || '',
      environmentId: env.POWERAPPS_ENVIRONMENT_ID || '',
      appId: env.POWERAPPS_APP_ID || '',
      logPath: path.resolve(env.POWERAPPS_LOG_PATH || 'data/powerapps-operations.jsonl')
    }
  };
}

module.exports = { getConfig };
