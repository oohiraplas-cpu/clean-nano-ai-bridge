const path = require('node:path');

const DEFAULT_ORIGINS = ['http://localhost:3000'];

function getConfig(env = process.env) {
  const origins = (env.CORS_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  return {
    port: Number.parseInt(env.PORT || '3000', 10),
    nodeEnv: env.NODE_ENV || 'development',
    corsOrigins: origins,
    tasksFile: path.resolve(env.TASKS_FILE || 'data/tasks.json'),
    webhookApiKey: env.WEBHOOK_API_KEY || '',
    mcpApiKey: env.MCP_API_KEY || ''
  };
}

module.exports = { getConfig };