require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { getConfig } = require('./config');
const { TaskStore } = require('./taskStore');
const { validateMcpInput, validateStatusInput, validateTaskInput } = require('./validation');

function apiKeyMiddleware(getKey) {
  return (req, res, next) => {
    const expected = getKey();
    if (!expected) return next();
    const actual = req.get('x-api-key') || '';
    const valid = actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    if (!valid) return res.status(401).json({ error: '認証に失敗しました' });
    return next();
  };
}

const MCP_METHODS = Object.freeze(['health_check', 'get_tasks', 'get_next_task']);

async function tasksPayload(store) {
  const tasks = await store.list();
  return { status: tasks.length ? 'ok' : 'タスクなし', count: tasks.length, tasks };
}

async function nextPayload(store) {
  const task = await store.next();
  return task ? { status: 'ok', task } : { status: 'タスクなし', task: null };
}

function createApp(config = getConfig(), store = new TaskStore(config.tasksFile)) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

  app.get('/api/tasks', async (req, res, next) => {
    try { return res.status(200).json(await tasksPayload(store)); } catch (error) { return next(error); }
  });

  app.get('/api/next', async (req, res, next) => {
    try { return res.status(200).json(await nextPayload(store)); } catch (error) { return next(error); }
  });

  const webhookAuth = apiKeyMiddleware(() => config.webhookApiKey);
  for (const path of ['/webhooks/claude-code', '/webhooks/copilot']) {
    app.post(path, webhookAuth, async (req, res, next) => {
      const errorMessage = validateTaskInput(req.body, { requireTitle: true });
      if (errorMessage) return res.status(400).json({ error: errorMessage });
      try {
        const task = await store.upsert({ ...req.body, source: path.slice('/webhooks/'.length) });
        return res.status(202).json({ accepted: true, task });
      } catch (error) { return next(error); }
    });
  }

  app.post('/api/tasks/:id/status', async (req, res, next) => {
    const body = { ...req.body, id: req.params.id };
    const errorMessage = validateStatusInput(body);
    if (errorMessage) return res.status(400).json({ error: errorMessage });
    try {
      const task = await store.update(req.params.id, req.body);
      return task ? res.status(200).json({ task }) : res.status(404).json({ error: 'タスクが見つかりません' });
    } catch (error) { return next(error); }
  });

  app.post('/mcp', apiKeyMiddleware(() => config.mcpApiKey), async (req, res, next) => {
    const errorMessage = validateMcpInput(req.body);
    if (errorMessage) return res.status(400).json({ error: errorMessage });
    const { method } = req.body;
    if (!MCP_METHODS.includes(method)) return res.status(400).json({ error: `不明なmethodです（対応: ${MCP_METHODS.join(', ')}）` });
    try {
      let result;
      if (method === 'health_check') result = { status: 'ok' };
      else if (method === 'get_tasks') result = await tasksPayload(store);
      else result = await nextPayload(store);
      return res.status(200).json({ accepted: true, method, result });
    } catch (error) { return next(error); }
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('request_failed', { method: req.method, path: req.path, message: error.message });
    return res.status(500).json({ error: '内部エラーが発生しました' });
  });
  return app;
}

if (require.main === module) {
  const config = getConfig();
  createApp(config).listen(config.port, config.host, () => console.log(`Bridge API listening on ${config.host}:${config.port}`));
}

module.exports = { apiKeyMiddleware, createApp };