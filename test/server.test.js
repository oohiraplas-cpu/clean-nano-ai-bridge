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
  const app = createApp({
    corsOrigins: ['http://localhost:3000'],
    tasksFile,
    webhookApiKey: options.webhookApiKey || '',
    mcpApiKey: options.mcpApiKey || ''
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

test('MCPの新規3ツール（create_task/update_task_status/get_task_result）を実行できる', async (t) => {
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

  // 既存3ツールにデグレがないことを確認する
  const health = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'health_check' }) });
  assert.deepEqual((await health.json()).result, { status: 'ok' });
  const tasks = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'get_tasks' }) });
  assert.equal((await tasks.json()).result.count, 2);
  const next = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'get_next_task' }) });
  assert.equal((await next.json()).result.task.id, 'task-1');
});

test('タスクが0件ならタスクなしを明示する', async (t) => {
  const server = await createTestServer([]);
  t.after(() => server.close());
  const tasks = await fetch(`${server.baseUrl}/api/tasks`);
  assert.equal((await tasks.json()).status, 'タスクなし');
  const next = await fetch(`${server.baseUrl}/api/next`);
  assert.deepEqual(await next.json(), { status: 'タスクなし', task: null });
});