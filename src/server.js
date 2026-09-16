require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { getConfig } = require('./config');
const { TaskStore } = require('./taskStore');
const { SharePointTaskStore } = require('./sharePointTaskStore');
const { PowerAppsStore } = require('./powerAppsStore');
const { PowerAppsGitStore } = require('./powerAppsGitStore');
const {
  validateMcpInput,
  validateStatusInput,
  validateTaskInput,
  validateCreateTaskParams,
  validateUpdateTaskStatusParams,
  validateGetTaskResultParams
} = require('./validation');
const {
  validatePowerAppsMcpInput,
  validateGetPowerAppsAppParams,
  validateGetPowerAppsStateParams,
  validateUpdatePowerAppsAppParams,
  validateSavePowerAppsAppParams,
  validatePublishPowerAppsAppParams,
  validateGetPowerAppsOperationResultParams,
  validateGetPowerAppsSourceParams
} = require('./powerAppsValidation');

function createDefaultStore(config) {
  if (config.taskStoreBackend === 'sharepoint') return new SharePointTaskStore(config.sharepoint);
  return new TaskStore(config.tasksFile);
}

function apiKeyMiddleware(getKey) {
  return (req, res, next) => {
    const expected = getKey();
    if (!expected) return next();
    const authorization = req.get('authorization') || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() || '';
    const actual = req.get('x-api-key') || bearer;
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    const valid = actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
    if (!valid) return res.status(401).json({ error: '認証に失敗しました' });
    return next();
  };
}

const MCP_METHODS = Object.freeze([
  'health_check', 'get_tasks', 'get_next_task',
  'create_task', 'update_task_status', 'get_task_result',
  'get_powerapps_app', 'get_powerapps_state', 'update_powerapps_app',
  'save_powerapps_app', 'publish_powerapps_app', 'get_powerapps_operation_result',
  'get_powerapps_source'
]);

const MCP_PUBLIC_TOOLS = Object.freeze([
  {
    name: 'health_check',
    description: 'Bridgeの稼働状態を確認します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_tasks',
    description: 'タスク一覧を取得します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_next_task',
    description: '次に実行可能なタスクを取得します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_powerapps_app',
    description: '既存Power Appsアプリの情報を取得します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_powerapps_state',
    description: '既存Power Appsアプリの現在状態を取得します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_powerapps_source',
    description: '既存Power Appsソースの指定ファイルを取得します。',
    inputSchema: {
      type: 'object',
      properties: { relativePath: { type: 'string', description: '取得するソースファイルの相対パス' } },
      required: ['relativePath'],
      additionalProperties: false
    }
  },
  {
    name: 'update_powerapps_app',
    description: '既存Power Appsアプリまたはソースファイルを更新します。',
    inputSchema: {
      type: 'object',
      properties: {
        updateData: { type: 'object', description: 'Power Apps管理APIへ送る更新内容' },
        relativePath: { type: 'string', description: '更新するソースファイルの相対パス' },
        content: { type: 'string', description: '更新後のファイル内容' },
        message: { type: 'string', description: '更新のコミットメッセージ' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'save_powerapps_app',
    description: '既存Power Appsアプリを保存します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'publish_powerapps_app',
    description: '既存Power Appsアプリを公開します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]);

async function tasksPayload(store) {
  const tasks = await store.list();
  return { status: tasks.length ? 'ok' : 'タスクなし', count: tasks.length, tasks };
}

async function nextPayload(store) {
  const task = await store.next();
  return task ? { status: 'ok', task } : { status: 'タスクなし', task: null };
}

async function createTaskPayload(store, params) {
  const task = await store.upsert({
    id: crypto.randomUUID(),
    title: params.title,
    description: params.description,
    priority: params.priority || 'normal',
    status: '未着手'
  });
  return { task_id: task.id, task };
}

async function updateTaskStatusPayload(store, params) {
  const patch = { status: params.status };
  if (params.result !== undefined) patch.result = params.result;
  return store.update(params.task_id, patch);
}

async function getTaskResultPayload(store, taskId) {
  const tasks = await store.list();
  return tasks.find((task) => task.id === taskId) || null;
}

function createApp(config = getConfig(), injectedStore, injectedPowerAppsStore, injectedPowerAppsGitStore) {
  const store = injectedStore || createDefaultStore(config);
  const powerAppsStore = injectedPowerAppsStore || new PowerAppsStore(config.powerApps);
  const powerAppsGitStore = injectedPowerAppsGitStore || new PowerAppsGitStore(config.powerApps);
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

  // Stateless JSON-response transport. Legacy Power Platform requests remain supported.
  app.use('/mcp', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !config.corsOrigins.includes(origin)) return res.sendStatus(403);
    return next();
  });
  app.get('/mcp/tools/list', apiKeyMiddleware(() => config.mcpApiKey), (req, res) => {
    res.status(200).json({ tools: MCP_PUBLIC_TOOLS });
  });

  app.get('/mcp', apiKeyMiddleware(() => config.mcpApiKey), (req, res) => {
    return res.set('Allow', 'POST').sendStatus(405);
  });

  app.post('/mcp', apiKeyMiddleware(() => config.mcpApiKey), async (req, res, next) => {
    if (req.body && Object.hasOwn(req.body, 'jsonrpc')) {
      const request = req.body;
      const id = request.id;
      const sendError = (code, message) => res.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
          (id !== undefined && typeof id !== 'string' && !Number.isInteger(id))) {
        return sendError(-32600, 'Invalid Request');
      }
      // Notifications never dispatch application tools or produce JSON-RPC responses.
      if (id === undefined) return res.status(202).end();
      if (request.method === 'initialize') {
        return res.json({ jsonrpc: '2.0', id, result: {
          protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'clean-nano-ai-bridge', version: '1.0.0' }
        } });
      }
      if (request.method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });
      if (request.method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: { tools: MCP_PUBLIC_TOOLS } });
      if (request.method !== 'tools/call') return sendError(-32601, 'Method not found');
      const params = request.params;
      if (!params || !MCP_PUBLIC_TOOLS.some((tool) => tool.name === params.name) ||
          (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)))) {
        return sendError(-32602, 'Invalid tool name or arguments');
      }
      req.body = { method: params.name, params: params.arguments || {} };
      // Adapt the existing validated dispatch, including its error responses.
      const json = res.json.bind(res);
      res.json = (payload) => {
        const isError = res.statusCode >= 400;
        res.status(200);
        return json({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: JSON.stringify(isError ? payload : payload.result) }],
          ...(isError ? { isError: true } : {})
        } });
      };
    }
    const errorMessage = validateMcpInput(req.body);
    if (errorMessage) return res.status(400).json({ error: errorMessage });
    const { method } = req.body;
    const params = req.body.params || {};
    if (!MCP_METHODS.includes(method)) return res.status(400).json({ error: `不明なmethodです（対応: ${MCP_METHODS.join(', ')}）` });
    try {
      let result;
      if (method === 'health_check') result = { status: 'ok' };
      else if (method === 'get_tasks') result = await tasksPayload(store);
      else if (method === 'get_next_task') result = await nextPayload(store);
      else if (method === 'create_task') {
        const paramError = validateCreateTaskParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        result = await createTaskPayload(store, params);
      } else if (method === 'update_task_status') {
        const paramError = validateUpdateTaskStatusParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        const task = await updateTaskStatusPayload(store, params);
        if (!task) return res.status(404).json({ error: 'タスクが見つかりません' });
        result = { task };
      } else if (method === 'get_task_result') {
        const paramError = validateGetTaskResultParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        const task = await getTaskResultPayload(store, params.task_id);
        if (!task) return res.status(404).json({ error: 'タスクが見つかりません' });
        result = { task_id: task.id, status: task.status, result: task.result ?? null };
      } else if (method === 'get_powerapps_source') {
        const paramError = validateGetPowerAppsSourceParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        result = await powerAppsGitStore.getSourceFile(params.relativePath);
      } else if (method === 'get_powerapps_app') {
        const paramError = validateGetPowerAppsAppParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        result = await powerAppsStore.getAppInfo();
      } else if (method === 'get_powerapps_state') {
        const paramError = validateGetPowerAppsStateParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        result = await powerAppsStore.getAppState();
      } else if (method === 'update_powerapps_app') {
        const paramError = validateUpdatePowerAppsAppParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        result = params.updateData
          ? await powerAppsStore.updateApp(params.updateData)
          : await powerAppsGitStore.updateSourceFile(params.relativePath, params.content, params.message);
      } else if (method === 'save_powerapps_app') {
        const paramError = validateSavePowerAppsAppParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        result = await powerAppsStore.saveApp();
      } else if (method === 'publish_powerapps_app') {
        const paramError = validatePublishPowerAppsAppParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        result = await powerAppsStore.publishApp();
      } else if (method === 'get_powerapps_operation_result') {
        const paramError = validateGetPowerAppsOperationResultParams(params);
        if (paramError) return res.status(400).json({ error: paramError });
        result = await powerAppsStore.getOperationResult(params.operationId);
      }
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

