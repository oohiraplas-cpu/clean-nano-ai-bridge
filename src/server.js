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

function createApp(config = getConfig(), store = new TaskStore(config.tasksFile)) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

  app.get('/api/tasks', async (req, res, next) => {
    try {
      const tasks = await store.list();
      return res.status(200).json({ status: tasks.length ? 'ok' : 'タスクなし', count: tasks.length, tasks });
    } catch (error) { return next(error); }
  });

  app.get('/api/next', async (req, res, next) => {
    try {
      const task = await store.next();
      return res.status(200).json(task ? { status: 'ok', task } : { status: 'タスクなし', task: null });
    } catch (error) { return next(error); }
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

  app.post('/mcp', apiKeyMiddleware(() => config.mcpApiKey), (req, res) => {
    const errorMessage = validateMcpInput(req.body);
    if (errorMessage) return res.status(400).json({ error: errorMessage });
    return res.status(200).json({ accepted: true, method: req.body.method });
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