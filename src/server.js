require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { getConfig } = require('./config');
const { TaskStore } = require('./taskStore');
const { SharePointTaskStore } = require('./sharePointTaskStore');
const { PowerAppsStore } = require('./powerAppsStore');
const { PowerAppsGitStore } = require('./powerAppsGitStore');
const { SharePointReader } = require('./sharePointReader');
const { SharePointListWriter, CN_EMPLOYEE_LEDGER_FIELD_MAP } = require('./sharePointListWriter');
const { PowerAutomateRunner } = require('./powerAutomateRunner');
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
const {
  validateGetSharePointListParams,
  validateRunPowerAutomateFlowParams,
  validateCreateEmployeeLedgerEntryParams,
  validateUpdateEmployeeLedgerEntryParams
} = require('./bridgeExtensionsValidation');

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
  'get_powerapps_source',
  'get_sharepoint_list', 'run_power_automate_flow',
  'create_employee_ledger_entry', 'update_employee_ledger_entry'
]);

const EMPLOYEE_LEDGER_RECORD_PROPERTIES = Object.freeze({
  name: { type: 'string', description: '氏名' },
  employeeId: { type: 'string', description: '社員ID' },
  department: { type: 'string', description: '所属' },
  employmentStatus: { type: 'string', description: '状態' },
  progressStatus: { type: 'string', description: '進捗状況' },
  hireDate: { type: 'string', description: '入社日（YYYY-MM-DD）' },
  remarks: { type: 'string', description: '備考' }
});

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
    name: 'create_task',
    description: 'ChatGPTからPower Appsへ渡す編集タスクを新規作成します。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '編集タスクのタイトル' },
        description: { type: 'string', description: 'Power Appsへ渡す具体的な編集内容' },
        priority: { type: 'string', description: '優先度（省略時normal）' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'update_task_status',
    description: '編集タスクの状態と実行結果を更新します。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '対象タスクID' },
        status: { type: 'string', description: '更新後の状態' },
        result: { description: '実行結果' }
      },
      required: ['task_id', 'status'],
      additionalProperties: false
    }
  },
  {
    name: 'get_task_result',
    description: '編集タスクの状態と実行結果を取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '対象タスクID' }
      },
      required: ['task_id'],
      additionalProperties: false
    }
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
    description: '既存Power Appsアプリを更新します。ソース更新時はGitHubへ保存後、Power Platformへ同期します。',
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
    description: 'GitHubの既存Power AppsソースをPower Platformへ同期し、保存状態を確認します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'publish_powerapps_app',
    description: '既存Power Appsアプリを公開します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_sharepoint_list',
    description: 'SharePointリストの項目を読み取り専用で取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: '取得するSharePointリストのID' },
        listName: { type: 'string', description: 'listId未指定時に表示名で検索するためのリスト名' },
        siteId: { type: 'string', description: '対象サイトID（省略時は既定のサイトを使用）' },
        top: { type: 'number', description: '取得件数の上限（既定50、最大200）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'run_power_automate_flow',
    description: '登録済みのPower AutomateフローをHTTPトリガー経由で実行します。人間承認（approvedByHuman:true）が必須です。',
    inputSchema: {
      type: 'object',
      properties: {
        flowKey: { type: 'string', description: '実行するフローの登録キー' },
        payload: { type: 'object', description: 'フローに渡す入力データ' },
        approvedByHuman: { type: 'boolean', description: '人間による承認済みであることを示すフラグ（true必須）' }
      },
      required: ['flowKey', 'approvedByHuman'],
      additionalProperties: false
    }
  },
  {
    name: 'create_employee_ledger_entry',
    description: 'CN_社員台帳へ新しい社員情報を1件登録します。列内部名は実環境で確認済みの固定マッピングを使用します。人間承認（approvedByHuman:true）が必須です。',
    inputSchema: {
      type: 'object',
      properties: {
        record: {
          type: 'object',
          description: '登録する項目',
          properties: EMPLOYEE_LEDGER_RECORD_PROPERTIES,
          additionalProperties: false
        },
        approvedByHuman: { type: 'boolean', description: '人間による承認済みであることを示すフラグ（true必須）' }
      },
      required: ['record', 'approvedByHuman'],
      additionalProperties: false
    }
  },
  {
    name: 'update_employee_ledger_entry',
    description: 'CN_社員台帳の既存社員情報を部分更新します。人間承認（approvedByHuman:true）が必須です。',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: '更新対象のSharePointアイテムID' },
        record: {
          type: 'object',
          description: '更新する項目（部分更新、指定したキーのみ上書き）',
          properties: EMPLOYEE_LEDGER_RECORD_PROPERTIES,
          additionalProperties: false
        },
        approvedByHuman: { type: 'boolean', description: '人間による承認済みであることを示すフラグ（true必須）' }
      },
      required: ['itemId', 'record', 'approvedByHuman'],
      additionalProperties: false
    }
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

// CN_社員台帳のsiteId/employeeLedgerListIdをSharePointListWriterに束縛し、未設定時は
// SharePointReader/SharePointTaskStoreと同じ文言でエラーにする（呼び出し元にconfigを
// 露出させない）。
function createEmployeeLedgerEntries(writer, sharepointConfig) {
  function assertConfigured() {
    const missingEnvNames = [];
    if (!sharepointConfig.siteId) missingEnvNames.push('SHAREPOINT_SITE_ID');
    if (!sharepointConfig.employeeLedgerListId) missingEnvNames.push('SHAREPOINT_EMPLOYEE_LEDGER_LIST_ID');
    if (missingEnvNames.length) {
      throw new Error(`SharePoint設定が不足しています: ${missingEnvNames.join(', ')}`);
    }
  }
  return {
    // assertConfigured()の同期throwがwithUpstreamErrorStatus()の外で発生しない
    // よう（=error.statusが設定されないまま素通りしないよう）async関数にしている。
    async createEntry(record) {
      assertConfigured();
      return writer.createItem(sharepointConfig.siteId, sharepointConfig.employeeLedgerListId, record);
    },
    async updateEntry(itemId, record) {
      assertConfigured();
      return writer.updateItem(sharepointConfig.siteId, sharepointConfig.employeeLedgerListId, itemId, record);
    }
  };
}

function assertPowerAppsSourceTarget(powerAppsStore, powerAppsGitStore) {
  const sourceAppId = powerAppsGitStore.sourceAppId;
  const sourceEnvironmentId = powerAppsGitStore.sourceEnvironmentId;
  if (!sourceAppId || !sourceEnvironmentId ||
      sourceAppId.toLowerCase() !== powerAppsStore.appId.toLowerCase() ||
      sourceEnvironmentId.toLowerCase() !== powerAppsStore.environmentId.toLowerCase()) {
    throw requestError('Power Appsのソース対象と操作対象が未確認または不一致です。POWERAPPS_SOURCE_APP_IDとPOWERAPPS_SOURCE_ENVIRONMENT_IDを実環境で照合してください。', 409);
  }
}

async function executeMcpMethod(method, params, store, powerAppsStore, powerAppsGitStore, sharePointReader, powerAutomateRunner, employeeLedgerEntries) {
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
    // Source edits are staged on the isolated Git branch only. Never write live Dataverse here.
    if (params.updateData) throw requestError('本番アプリ管理APIの直接更新は停止中です。');
    assertPowerAppsSourceTarget(powerAppsStore, powerAppsGitStore);
    if (!powerAppsGitStore.githubBranch === 'work/cn-aiiraidaicho-stage-20260927') {
      throw requestError('編集停止: 隔離済み17ファイルのブランチではありません。');
    }
    const staged = await withUpstreamErrorStatus(powerAppsGitStore.updateSourceFile(params.relativePath, params.content, params.message));
    return { ...staged, status: 'staged', productionChanged: false, note: 'GitHub隔離ブランチのみ更新。本番Power Appsは未変更。' };
  }
  if (method === 'save_powerapps_app') {
    const paramError = validateSavePowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    assertPowerAppsSourceTarget(powerAppsStore, powerAppsGitStore);
    // Fail closed: neither a backup artifact nor a Git SHA proves that the live Canvas app
    // matches this source, and the solution restore path has not been tested.
    // This branch intentionally performs no Dataverse refresh/pull or live save.
    throw requestError('保存停止: 本番Canvasソース一致と復元テストが未確認です。変更は実行していません。');
  }
  if (method === 'publish_powerapps_app') {
    const paramError = validatePublishPowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    assertPowerAppsSourceTarget(powerAppsStore, powerAppsGitStore);
    throw requestError('公開停止: 本番保存の独立検証と復元テストが未完了です。');
  }
  if (method === 'get_powerapps_operation_result') {
    const paramError = validateGetPowerAppsOperationResultParams(params);
    if (paramError) throw requestError(paramError);
    return powerAppsStore.getOperationResult(params.operationId);
  }
  if (method === 'get_sharepoint_list') {
    const paramError = validateGetSharePointListParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(sharePointReader.listItems(params));
  }
  if (method === 'run_power_automate_flow') {
    // approvedByHuman:trueはvalidateRunPowerAutomateFlowParamsで必須チェック済み。
    // Bridge全体の方針（更新・実行系は人間承認必須）に合わせ、ここでも他の
    // パラメータ検証と同様400として扱う（フラグが無い＝入力不備という位置づけ）。
    const paramError = validateRunPowerAutomateFlowParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(powerAutomateRunner.runFlow(params.flowKey, params.payload));
  }
  if (method === 'create_employee_ledger_entry') {
    // approvedByHuman:trueはvalidateCreateEmployeeLedgerEntryParamsで必須チェック済み。
    // run_power_automate_flowと同じ方針（AI単独承認禁止）。
    const paramError = validateCreateEmployeeLedgerEntryParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(employeeLedgerEntries.createEntry(params.record));
  }
  if (method === 'update_employee_ledger_entry') {
    const paramError = validateUpdateEmployeeLedgerEntryParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(employeeLedgerEntries.updateEntry(params.itemId, params.record));
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

function createApp(config = getConfig(), injectedStore, injectedPowerAppsStore, injectedPowerAppsGitStore, injectedSharePointReader, injectedPowerAutomateRunner, injectedEmployeeLedgerWriter) {
  const store = injectedStore || createDefaultStore(config);
  const powerAppsStore = injectedPowerAppsStore || new PowerAppsStore(config.powerApps);
  const powerAppsGitStore = injectedPowerAppsGitStore || new PowerAppsGitStore(config.powerApps);
  const sharePointReader = injectedSharePointReader || new SharePointReader(config.sharepoint);
  const powerAutomateRunner = injectedPowerAutomateRunner || new PowerAutomateRunner(config.powerAutomate);
  const employeeLedgerWriter = injectedEmployeeLedgerWriter
    || new SharePointListWriter({ ...config.sharepoint, fieldMap: CN_EMPLOYEE_LEDGER_FIELD_MAP });
  const employeeLedgerEntries = createEmployeeLedgerEntries(employeeLedgerWriter, config.sharepoint);
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
          const result = await executeMcpMethod(name, toolParams, store, powerAppsStore, powerAppsGitStore, sharePointReader, powerAutomateRunner, employeeLedgerEntries);
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
      const result = await executeMcpMethod(method, params, store, powerAppsStore, powerAppsGitStore, sharePointReader, powerAutomateRunner, employeeLedgerEntries);
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
