const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/server');

async function createTestServer(tasks, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clean-nano-ai-bridge-'));
  const tasksFile = path.join(directory, 'tasks.json');
  await fs.writeFile(tasksFile, `${JSON.stringify(tasks)}\n`);
  const logFile = path.join(directory, 'powerapps-operations.jsonl');
  const app = createApp({
    corsOrigins: ['http://localhost:3000'],
    tasksFile,
    webhookApiKey: options.webhookApiKey || '',
    mcpApiKey: options.mcpApiKey || '',
    powerApps: {
      tenantId: 'test-tenant',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      environmentId: 'test-env',
      appId: 'test-app',
      logPath: logFile,
      managementApiBaseUrl: 'https://management.azure.com',
      fetchImpl: options.fetchImpl
    }
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const seedTask = { id: 'task-1', title: 'テスト', status: '未着手', retry_count: 0 };

test('必須APIと状態制御を提供する', async (t) => {
  const server = await createTestServer([seedTask]);
  t.after(() => server.close());
  const health = await fetch(`${server.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const tasks = await fetch(`${server.baseUrl}/api/tasks`);
  assert.equal((await tasks.json()).count, 1);
  const next = await fetch(`${server.baseUrl}/api/next`);
  assert.equal((await next.json()).task.id, 'task-1');

  const webhook = await fetch(`${server.baseUrl}/webhooks/copilot`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'task-2', title: 'Webhook task' })
  });
  assert.equal(webhook.status, 202);
  assert.equal((await webhook.json()).task.source, 'copilot');

  const stopped = await fetch(`${server.baseUrl}/api/tasks/task-1/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ retry_count: 3, status: 'エラー' })
  });
  assert.equal((await stopped.json()).task.status, '停止');
  const approval = await fetch(`${server.baseUrl}/api/tasks/task-2/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approval_required: true })
  });
  assert.equal((await approval.json()).task.status, '人間承認待ち');
  const userAction = await fetch(`${server.baseUrl}/api/tasks/task-2/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approval_required: false, userActionRequired: true })
  });
  assert.equal((await userAction.json()).task.status, 'ユーザー操作待ち');
  const noNext = await fetch(`${server.baseUrl}/api/next`);
  assert.equal((await noNext.json()).status, 'タスクなし');
});

test('入力検証、APIキー、MCPを扱う', async (t) => {
  const server = await createTestServer([seedTask], { webhookApiKey: 'webhook-secret', mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const unauthorized = await fetch(`${server.baseUrl}/webhooks/claude-code`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  const invalid = await fetch(`${server.baseUrl}/webhooks/claude-code`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'webhook-secret' }, body: JSON.stringify({ id: 'x' })
  });
  assert.equal(invalid.status, 400);
  const mcpUnknown = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' }, body: JSON.stringify({ method: 'tasks.next', params: {} })
  });
  assert.equal(mcpUnknown.status, 400);
});

test('MCPの標準メソッドをBridge経由で実行できる', async (t) => {
  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const health = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'health_check' }) });
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).result, { status: 'ok' });

  const tasks = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'get_tasks' }) });
  assert.equal((await tasks.json()).result.count, 1);

  const next = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'get_next_task' }) });
  assert.equal((await next.json()).result.task.id, 'task-1');
});

test('MCPの新览3ツール（create_task/update_task_status/get_task_result）を実行できる', async (t) => {
  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const created = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'create_task', params: { title: '新規タスク', description: '説明', priority: 'high' } })
  });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.result.task.status, '未着手');
  assert.equal(createdBody.result.task.title, '新規タスク');
  assert.equal(createdBody.result.task.priority, 'high');
  const taskId = createdBody.result.task_id;
  assert.ok(taskId);

  const updated = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'update_task_status', params: { task_id: taskId, status: '完了', result: '完了しました' } })
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).result.task.status, '完了');

  const resultPayload = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get_task_result', params: { task_id: taskId } })
  });
  assert.equal(resultPayload.status, 200);
  const resultBody = (await resultPayload.json()).result;
  assert.equal(resultBody.status, '完了');
  assert.equal(resultBody.result, '完了しました');

  const missingUpdate = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'update_task_status', params: { task_id: 'no-such-task', status: '完了' } })
  });
  assert.equal(missingUpdate.status, 404);

  const missingResult = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get_task_result', params: { task_id: 'no-such-task' } })
  });
  assert.equal(missingResult.status, 404);

  const invalidCreate = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'create_task', params: {} })
  });
  assert.equal(invalidCreate.status, 400);

  const health = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'health_check' }) });
  assert.deepEqual((await health.json()).result, { status: 'ok' });
  const tasksList = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'get_tasks' }) });
  assert.equal((await tasksList.json()).result.count, 2);
  const nextTask = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'get_next_task' }) });
  assert.equal((await nextTask.json()).result.task.id, 'task-1');
});

test('Power Apps MCPメソッドを実行できる', async (t) => {
  const mockFetch = async (url, options) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({
        access_token: 'mock-token',
        expires_in: 3600
      }), { status: 200 });
    }
    if (url.includes('/apps/test-app')) {
      return new Response(JSON.stringify({
        properties: {
          displayName: 'Test App',
          publisher: 'Test',
          appType: 'CanvasApp',
          versionNumber: '1.0'
        }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };

  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret', fetchImpl: mockFetch });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const appInfo = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get_powerapps_app', params: {} })
  });
  assert.equal(appInfo.status, 200);
  const appResult = await appInfo.json();
  assert.equal(appResult.result.status, 'ok');
  assert.equal(appResult.result.displayName, 'Test App');

  const state = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get_powerapps_state', params: {} })
  });
  assert.equal(state.status, 200);
  const stateResult = await state.json();
  assert.equal(stateResult.result.status, 'ok');
  assert.ok(stateResult.result.operationId);
});

test('タスクが0件ならタスクなしを明示する', async (t) => {
  const server = await createTestServer([]);
  t.after(() => server.close());
  const tasks = await fetch(`${server.baseUrl}/api/tasks`);
  assert.equal((await tasks.json()).status, 'タスクなし');
  const next = await fetch(`${server.baseUrl}/api/next`);
  assert.deepEqual(await next.json(), { status: 'タスクなし', task: null });
});


test('MCPツール一覧で既存3ツールとPower Apps 6ツールを公開する', async (t) => {
  const server = await createTestServer([], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());

  const unauthorized = await fetch(`${server.baseUrl}/mcp/tools/list`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${server.baseUrl}/mcp/tools/list`, {
    headers: { 'x-api-key': 'mcp-secret' }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tools.map((tool) => tool.name), [
    'health_check',
    'get_tasks',
    'get_next_task',
    'get_powerapps_app',
    'get_powerapps_state',
    'get_powerapps_source',
    'update_powerapps_app',
    'save_powerapps_app',
    'publish_powerapps_app'
  ]);
  for (const tool of body.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
});


test('ChatGPT Apps向け標準MCP initialize/tools/list/tools/callに対応する', async (t) => {
  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'x-api-key': 'mcp-secret'
  };

  const initialized = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    })
  });
  assert.equal(initialized.status, 200);
  const initializedBody = await initialized.json();
  assert.equal(initializedBody.jsonrpc, '2.0');
  assert.equal(initializedBody.result.serverInfo.name, 'clean-nano-ai-bridge');
  assert.equal(initializedBody.result.protocolVersion, '2025-06-18');

  const listed = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.result.tools.length, 9);
  assert.ok(listedBody.result.tools.some((tool) => tool.name === 'get_powerapps_app'));
  assert.ok(listedBody.result.tools.some((tool) => tool.name === 'publish_powerapps_app'));

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health_check', arguments: {} } })
  });
  assert.equal(called.status, 200);
  const calledBody = await called.json();
  assert.equal(calledBody.result.isError, false);
  assert.deepEqual(calledBody.result.structuredContent, { status: 'ok' });
});
