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
    const actual = req.get('x-api-key') || '';
    const valid = actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
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

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// powerAppsGitStore (GitHub Contents API経由)の呼び出しは、設定不足やGitHub側のエラーを
// プレーンなErrorとして投げる。error.statusが未設定のまま/mcpのtools/callハンドラに届くと
// 中央エラーハンドラの汎用500応答に丸められ、実際の原因（設定不足、404など）が失われるうえ、
// 一部のMCPリレー/プロキシは200以外のHTTPステータスを「オリジン異常」とみなして
// 502に置き換えてしまうことがある。ここでerror.statusを必ず設定し、
// tools/callが常にHTTP 200 + isError:trueで詳細メッセージを返せるようにする。
async function withUpstreamErrorStatus(promise, status = 502) {
  try {
    return await promise;
  } catch (error) {
    if (!error.status) error.status = status;
    throw error;
  }
}

async function executeMcpMethod(method, params, store, powerAppsStore, powerAppsGitStore) {
  if (!MCP_METHODS.includes(method)) {
    throw requestError(`不明なmethodです（対応: ${MCP_METHODS.join(', ')}）`);
  }

  if (method === 'health_check') return { status: 'ok' };
  if (method === 'get_tasks') return tasksPayload(store);
  if (method === 'get_next_task') return nextPayload(store);
  if (method === 'create_task') {
    const paramError = validateCreateTaskParams(params);
    if (paramError) throw requestError(paramError);
    return createTaskPayload(store, params);
  }
  if (method === 'update_task_status') {
    const paramError = validateUpdateTaskStatusParams(params);
    if (paramError) throw requestError(paramError);
    const task = await updateTaskStatusPayload(store, params);
    if (!task) throw requestError('タスクが見つかりません', 404);
    return { task };
  }
  if (method === 'get_task_result') {
    const paramError = validateGetTaskResultParams(params);
    if (paramError) throw requestError(paramError);
    const task = await getTaskResultPayload(store, params.task_id);
    if (!task) throw requestError('タスクが見つかりません', 404);
    return { task_id: task.id, status: task.status, result: task.result ?? null };
  }
  if (method === 'get_powerapps_source') {
    const paramError = validateGetPowerAppsSourceParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(powerAppsGitStore.getSourceFile(params.relativePath));
  }
  if (method === 'get_powerapps_app') {
    const paramError = validateGetPowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    return powerAppsStore.getAppInfo();
  }
  if (method === 'get_powerapps_state') {
    const paramError = validateGetPowerAppsStateParams(params);
    if (paramError) throw requestError(paramError);
    return powerAppsStore.getAppState();
  }
  if (method === 'update_powerapps_app') {
    const paramError = validateUpdatePowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    return params.updateData
      ? powerAppsStore.updateApp(params.updateData)
      : withUpstreamErrorStatus(powerAppsGitStore.updateSourceFile(params.relativePath, params.content, params.message));
  }
  if (method === 'save_powerapps_app') {
    const paramError = validateSavePowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    return powerAppsStore.saveApp();
  }
  if (method === 'publish_powerapps_app') {
    const paramError = validatePublishPowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    return powerAppsStore.publishApp();
  }
  if (method === 'get_powerapps_operation_result') {
    const paramError = validateGetPowerAppsOperationResultParams(params);
    if (paramError) throw requestError(paramError);
    return powerAppsStore.getOperationResult(params.operationId);
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
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

  app.get('/mcp/tools/list', (req, res) => {
    res.status(200).json({ tools: MCP_PUBLIC_TOOLS });
  });

  app.post('/mcp', (req, res, next) => handleMcpRequest(req, res, next));

  async function handleMcpRequest(req, res, next) {
    const body = req.body || {};

    // ChatGPT Apps use MCP Streamable HTTP with JSON-RPC 2.0.
    // Keep the existing legacy { method, params } contract below for current clients.
    if (body.jsonrpc === '2.0') {
      const id = body.id;
      const params = body.params || {};

      if (body.method === 'notifications/initialized') return res.status(202).end();
      if (body.method === 'ping') return res.status(200).json(jsonRpcResult(id, {}));
      if (body.method === 'initialize') {
        return res.status(200).json(jsonRpcResult(id, {
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'clean-nano-ai-bridge', version: '1.0.0' }
        }));
      }
      if (body.method === 'tools/list') {
        return res.status(200).json(jsonRpcResult(id, { tools: MCP_PUBLIC_TOOLS }));
      }
      if (body.method === 'tools/call') {
        const name = params.name;
        const toolParams = params.arguments || {};
        if (typeof name !== 'string') {
          return res.status(200).json(jsonRpcError(id, -32602, 'tools/callにはparams.nameが必要です'));
        }
        try {
          const result = await executeMcpMethod(name, toolParams, store, powerAppsStore, powerAppsGitStore);
          return res.status(200).json(jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false
          }));
        } catch (error) {
          if (!error.status) return next(error);
          return res.status(200).json(jsonRpcResult(id, {
            content: [{ type: 'text', text: error.message }],
            structuredContent: { error: error.message },
            isError: true
          }));
        }
      }
      return res.status(200).json(jsonRpcError(id, -32601, `Method not found: ${body.method || ''}`));
    }

    const errorMessage = validateMcpInput(body);
    if (errorMessage) return res.status(400).json({ error: errorMessage });
    const { method } = body;
    const params = body.params || {};
    try {
      const result = await executeMcpMethod(method, params, store, powerAppsStore, powerAppsGitStore);
      return res.status(200).json({ accepted: true, method, result });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      return next(error);
    }
  }

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
