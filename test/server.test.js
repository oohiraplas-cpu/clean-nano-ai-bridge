const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, MCP_METHODS, MCP_PUBLIC_TOOLS } = require('../src/server');

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
      fetchImpl: options.fetchImpl,
      ...options.powerAppsOverrides
    },
    sharepoint: {
      tenantId: 'test-tenant',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      siteId: 'test-site',
      fetchImpl: options.fetchImpl,
      ...options.sharepointOverrides
    },
    powerAutomate: {
      flows: {},
      fetchImpl: options.fetchImpl,
      ...options.powerAutomateOverrides
    },
    deployment: {
      fetchImpl: options.fetchImpl,
      historyPath: path.join(directory, 'deployments.jsonl'),
      healthAttempts: 1,
      healthRetryDelayMs: 0,
      ...options.deploymentOverrides
    },
    permissions: { ...options.permissionsOverrides }
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

test('save_powerapps_appはGitHub再書込なしでPower Platform同期後に保存確認する', async (t) => {
  const actions = [];
  const mockFetch = async (url, options = {}) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith('/RefreshChangesFromGit') || url.endsWith('/PullChangesFromGit')) {
      actions.push(url.split('/').pop());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes('/canvasapps(')) {
      return new Response(JSON.stringify({ displayname: 'Test App', appversion: '1.1' }), { status: 200 });
    }
    if (url.includes('/solutions?')) {
      return new Response(JSON.stringify({ value: [{
        solutionid: 'solution-1', uniquename: 'ActualSolution',
        friendlyname: 'Actual Solution', version: '1.0.0.0', ismanaged: false
      }] }), { status: 200 });
    }
    if (url.includes('/apps/test-app')) {
      return new Response(JSON.stringify({ properties: { displayName: 'Test App', appVersion: '1.1' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    fetchImpl: mockFetch,
    powerAppsOverrides: {
      orgUrl: 'https://example.crm.dynamics.com',
      solutionUniqueName: 'CN_CompanyOS',
      githubToken: 'read-only-is-enough', githubOwner: 'owner', githubRepo: 'repo'
    }
  });
  t.after(() => server.close());

  const saved = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' },
    body: JSON.stringify({ method: 'save_powerapps_app', params: { branch: 'main' } })
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.result.status, 'ok');
  assert.equal(savedBody.result.sync.refresh.action, 'RefreshChangesFromGit');
  assert.equal(savedBody.result.sync.pull.action, 'PullChangesFromGit');
  assert.deepEqual(actions, ['RefreshChangesFromGit', 'PullChangesFromGit']);
});

test('save_powerapps_appはPower Apps APIが2xx成功かつ空bodyでもJSON解析エラーにしない', async (t) => {
  const actions = [];
  const mockFetch = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    if (url.endsWith('/RefreshChangesFromGit') || url.endsWith('/PullChangesFromGit')) {
      actions.push(url.split('/').pop());
      return new Response('', { status: 200 });
    }
    if (url.includes('/canvasapps(')) return new Response(JSON.stringify({ displayname: 'Test App', appversion: '1.1' }), { status: 200 });
    if (url.includes('/solutions?')) return new Response(JSON.stringify({ value: [{ solutionid: 'solution-1', uniquename: 'ActualSolution', friendlyname: 'Actual Solution', version: '1.0.0.0', ismanaged: false }] }), { status: 200 });
    if (url.includes('/apps/test-app')) return new Response(JSON.stringify({ properties: { displayName: 'Test App', appVersion: '1.1' } }), { status: 200 });
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret', fetchImpl: mockFetch,
    powerAppsOverrides: { orgUrl: 'https://example.crm.dynamics.com', solutionUniqueName: 'CN_CompanyOS', githubToken: 'read-only-is-enough', githubOwner: 'owner', githubRepo: 'repo' }
  });
  t.after(() => server.close());
  const saved = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' }, body: JSON.stringify({ method: 'save_powerapps_app', params: { branch: 'main' } }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).result.status, 'ok');
  assert.deepEqual(actions, ['RefreshChangesFromGit', 'PullChangesFromGit']);
});

test('get_powerapps_sourceはGitHub設定不足時も生の500/502で落ちずJSON-RPCエラーとして応答する', async (t) => {
  // GitHub連携設定（POWERAPPS_GITHUB_TOKEN等）が未設定の状態を再現する。
  // 修正前はpowerAppsGitStoreが投げるErrorにstatusが付かず、/mcpのtools/callハンドラが
  // next(error)経由の汎用500に丸めてしまい、一部のMCPリレーがそれを502として扱っていた。
  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_powerapps_source', arguments: { relativePath: 'Screen3.pa.yaml' } }
    })
  });
  // tools/callは常にHTTP 200で返し、成否はresult.isErrorで表現する（他のツールと同じ規約）。
  assert.equal(called.status, 200);
  const body = await called.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.structuredContent.error, /GitHub設定が不足しています/);

  // レガシー{method, params}形式でもres.headersSent前に必ずJSONで応答し、
  // 素の502/500として観測されないことを確認する。
  const legacy = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get_powerapps_source', params: { relativePath: 'Screen3.pa.yaml' } })
  });
  assert.equal(legacy.status, 502);
  const legacyBody = await legacy.json();
  assert.match(legacyBody.error, /GitHub設定が不足しています/);
});

test('get_powerapps_sourceはGitHub設定が揃っていれば正常応答する', async (t) => {
  const mockFetch = async (url) => {
    if (url.includes('/contents/')) {
      return new Response(JSON.stringify({
        type: 'file',
        sha: 'abc123',
        content: Buffer.from('Screen3のPower Fxソース', 'utf8').toString('base64')
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    powerAppsOverrides: {
      githubToken: 'dummy-token',
      githubOwner: 'oohiraplas-cpu',
      githubRepo: 'clean-nano-ai-bridge',
      githubBranch: 'main',
      githubRoot: 'powerapps/CN_CompanyOS_ElectronicDailyReport/Source',
      fetchImpl: mockFetch
    }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_powerapps_source', arguments: { relativePath: 'Screen3.pa.yaml' } }
    })
  });
  assert.equal(called.status, 200);
  const body = await called.json();
  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.status, 'ok');
  assert.equal(body.result.structuredContent.content, 'Screen3のPower Fxソース');
});

test('タスクが0件ならタスクなしを明示する', async (t) => {
  const server = await createTestServer([]);
  t.after(() => server.close());
  const tasks = await fetch(`${server.baseUrl}/api/tasks`);
  assert.equal((await tasks.json()).status, 'タスクなし');
  const next = await fetch(`${server.baseUrl}/api/next`);
  assert.deepEqual(await next.json(), { status: 'タスクなし', task: null });
});


test('MCPツール一覧でタスク6ツール、Power Apps 6ツール、SharePoint/Power Automate 2ツール、CN_社員台帳2ツールを公開する', async (t) => {
  const server = await createTestServer([], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());

  const response = await fetch(`${server.baseUrl}/mcp/tools/list`, { headers: { 'x-api-key': 'mcp-secret' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  // 既存18ツールは名前と順序を維持したまま、先頭に並ぶ（後方互換）。
  assert.deepEqual(body.tools.map((tool) => tool.name).slice(0, 18), [
    'health_check',
    'get_tasks',
    'get_next_task',
    'create_task',
    'update_task_status',
    'get_task_result',
    'get_powerapps_app',
    'get_powerapps_state',
    'get_powerapps_source',
    'update_powerapps_app',
    'save_powerapps_app',
    'publish_powerapps_app',
    'get_sharepoint_list',
    'get_sharepoint_columns',
    'ensure_sharepoint_columns',
    'run_power_automate_flow',
    'create_employee_ledger_entry',
    'update_employee_ledger_entry'
  ]);
  for (const tool of body.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('get_sharepoint_listはSharePoint設定不足時もJSON-RPCエラーとして応答する', async (t) => {
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    sharepointOverrides: { tenantId: '', clientId: '', clientSecret: '' }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_sharepoint_list', arguments: { listName: 'CN_電子日報台帳' } }
    })
  });
  assert.equal(called.status, 200);
  const body = await called.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.structuredContent.error, /SharePoint設定が不足しています/);
});

test('get_sharepoint_listはlistId/listNameいずれも未指定なら400を返す', async (t) => {
  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get_sharepoint_list', params: {} })
  });
  assert.equal(called.status, 400);
  assert.match((await called.json()).error, /listIdまたはlistName/);
});

test('get_sharepoint_listは設定が揃っていれば項目を取得できる', async (t) => {
  const mockFetch = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('/lists?')) {
      return new Response(JSON.stringify({ value: [{ id: 'list-1', displayName: 'CN_電子日報台帳' }] }), { status: 200 });
    }
    if (url.includes('/items?')) {
      return new Response(JSON.stringify({ value: [{ id: 'item-1', fields: { Title: '2026-09-18分' } }] }), { status: 200 });
    }
    if (url.includes('/columns')) {
      return new Response(JSON.stringify({ value: [{ id: 'c1', name: 'Title', displayName: 'タイトル', required: false, text: { allowMultipleLines: false } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    sharepointOverrides: { fetchImpl: mockFetch }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'get_sharepoint_list', params: { listName: 'CN_電子日報台帳' } })
  });
  assert.equal(called.status, 200);
  const body = await called.json();
  assert.equal(body.result.status, 'ok');
  assert.equal(body.result.count, 1);
  assert.equal(body.result.items[0].fields.Title, '2026-09-18分');
});

test('run_power_automate_flowはapprovedByHuman未指定だと実行されず400を返す', async (t) => {
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    powerAutomateOverrides: { flows: { daily_report_reminder: 'https://example.com/trigger' } }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'run_power_automate_flow', params: { flowKey: 'daily_report_reminder' } })
  });
  assert.equal(called.status, 400);
  assert.match((await called.json()).error, /approvedByHuman/);
});

test('run_power_automate_flowは未登録のflowKeyを明確なエラーで返す', async (t) => {
  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'run_power_automate_flow', arguments: { flowKey: 'no-such-flow', approvedByHuman: true } }
    })
  });
  assert.equal(called.status, 200);
  const body = await called.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.structuredContent.error, /指定されたflowKeyのPower Automateフローが設定されていません/);
});

test('run_power_automate_flowはapprovedByHuman:true指定かつ登録済みなら実行される', async (t) => {
  const mockFetch = async () => new Response(JSON.stringify({ received: true }), { status: 202 });
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    powerAutomateOverrides: { flows: { daily_report_reminder: 'https://example.com/trigger' }, fetchImpl: mockFetch }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      method: 'run_power_automate_flow',
      params: { flowKey: 'daily_report_reminder', payload: { message: 'テスト' }, approvedByHuman: true }
    })
  });
  assert.equal(called.status, 200);
  const body = await called.json();
  assert.equal(body.result.status, 'ok');
  assert.equal(body.result.httpStatus, 202);
  assert.deepEqual(body.result.result, { received: true });
});

test('create_employee_ledger_entryはapprovedByHuman未指定だと実行されず400を返す', async (t) => {
  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'create_employee_ledger_entry', params: { record: { name: 'テスト太郎' } } })
  });
  assert.equal(called.status, 400);
  assert.match((await called.json()).error, /approvedByHuman/);
});

test('create_employee_ledger_entryはSharePoint設定不足時もJSON-RPCエラーとして応答する', async (t) => {
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    sharepointOverrides: { siteId: '', employeeLedgerListId: '' }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'create_employee_ledger_entry', arguments: { record: { name: 'テスト太郎' }, approvedByHuman: true } }
    })
  });
  assert.equal(called.status, 200);
  const body = await called.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.structuredContent.error, /SharePoint設定が不足しています/);
  assert.match(body.result.structuredContent.error, /SHAREPOINT_EMPLOYEE_LEDGER_LIST_ID/);
});

test('create_employee_ledger_entryは承認済みかつ設定が揃っていればCN_社員台帳へ登録できる', async (t) => {
  const writes = [];
  const mockFetch = async (url, options = {}) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }
    if (options.method === 'POST') {
      writes.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: 'new-item-1' }), { status: 201 });
    }
    throw new Error(`予期しないリクエスト: ${url}`);
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    sharepointOverrides: { siteId: 'site-1', employeeLedgerListId: 'list-employee-1', fetchImpl: mockFetch }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      method: 'create_employee_ledger_entry',
      params: { record: { name: '山田太郎', employeeId: 'EMP010', department: '現場' }, approvedByHuman: true }
    })
  });
  assert.equal(called.status, 200);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.includes('/sites/site-1/lists/list-employee-1/items'));
  assert.deepEqual(writes[0].body, { fields: { Title: '山田太郎', EmployeeID: 'EMP010', Department: '現場' } });
});

test('update_employee_ledger_entryはitemId未指定だと400を返す', async (t) => {
  const server = await createTestServer([seedTask], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      method: 'update_employee_ledger_entry',
      params: { record: { employmentStatus: '退職' }, approvedByHuman: true }
    })
  });
  assert.equal(called.status, 400);
  assert.match((await called.json()).error, /itemId/);
});

test('update_employee_ledger_entryは承認済みかつ設定が揃っていればCN_社員台帳を更新できる', async (t) => {
  const writes = [];
  const mockFetch = async (url, options = {}) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }
    if (options.method === 'PATCH') {
      writes.push({ url, body: JSON.parse(options.body) });
      return new Response(null, { status: 204 });
    }
    throw new Error(`予期しないリクエスト: ${url}`);
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    sharepointOverrides: { siteId: 'site-1', employeeLedgerListId: 'list-employee-1', fetchImpl: mockFetch }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };

  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      method: 'update_employee_ledger_entry',
      params: { itemId: 'item-9', record: { employmentStatus: '退職' }, approvedByHuman: true }
    })
  });
  assert.equal(called.status, 200);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.includes('/sites/site-1/lists/list-employee-1/items/item-9/fields'));
  assert.deepEqual(writes[0].body, { EmploymentStatus: '退職' });
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
  // 既存28ツール + 優先A機能4ツール + 優先B機能4ツール + Knowledge/対象解決6ツール + ユーザー保護7ツール + Executive2ツール。
  assert.equal(listedBody.result.tools.length, MCP_PUBLIC_TOOLS.length);
  assert.ok(listedBody.result.tools.some((tool) => tool.name === 'create_task'));
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

test('get_powerapps_app({})はtools/callで上流エラー時もHTTP status・error code・失敗工程を返す（秘密値なし）', async (t) => {
  const mockFetch = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'AppNotFound', message: 'The app was not found.' } }), { status: 404 });
  };
  const server = await createTestServer([], { mcpApiKey: 'mcp-secret', fetchImpl: mockFetch });
  t.after(() => server.close());
  const response = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_powerapps_app', arguments: {} } })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, true);
  const details = body.result.structuredContent.details;
  assert.equal(details.httpStatus, 404);
  assert.equal(details.errorCode, 'AppNotFound');
  assert.equal(details.step, 'Power Apps管理API呼び出し');
  assert.equal(details.errorMessage, 'The app was not found.');
  assert.ok(!JSON.stringify(body).includes('test-secret'));
  assert.ok(!JSON.stringify(body).includes('mock-token'));
});

test('get_powerapps_app({})は認証トークン取得失敗を工程付きで返す', async (t) => {
  const mockFetch = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' }), { status: 401 });
    }
    return new Response('{}', { status: 200 });
  };
  const server = await createTestServer([], { mcpApiKey: 'mcp-secret', fetchImpl: mockFetch });
  t.after(() => server.close());
  const response = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_powerapps_app', arguments: {} } })
  });
  const body = await response.json();
  assert.equal(body.result.isError, true);
  const details = body.result.structuredContent.details;
  assert.equal(details.httpStatus, 401);
  assert.equal(details.errorCode, 'invalid_client');
  assert.match(details.step, /^認証トークン取得/);
  assert.ok(!details.errorMessage.includes('Trace ID'));
});

test('get_powerapps_app({})はDataverse補足取得に失敗してもアプリ名とApp IDを返す', async (t) => {
  const mockFetch = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('/api/data/v9.2/')) {
      return new Response(JSON.stringify({ error: { code: '0x80040220', message: 'Principal user is missing prvReadCanvasApp privilege' } }), { status: 403 });
    }
    return new Response(JSON.stringify({ name: 'test-app', properties: { displayName: 'Test App' } }), { status: 200 });
  };
  const server = await createTestServer([], {
    mcpApiKey: 'mcp-secret', fetchImpl: mockFetch,
    powerAppsOverrides: { orgUrl: 'https://org.example.crm7.dynamics.com' }
  });
  t.after(() => server.close());
  const response = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_powerapps_app', arguments: {} } })
  });
  const body = await response.json();
  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.displayName, 'Test App');
  assert.equal(body.result.structuredContent.appId, 'test-app');
  assert.equal(body.result.structuredContent.warning.httpStatus, 403);
});


test('Copilot Studio向けMCPはAPIキー必須かつStreamable HTTP POSTを維持する', async (t) => {
  const server = await createTestServer([], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());

  const unauthorized = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'copilot-studio', version: '1' } } })
  });
  assert.equal(unauthorized.status, 401);

  const getResponse = await fetch(`${server.baseUrl}/mcp`, { headers: { 'x-api-key': 'mcp-secret' } });
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get('allow'), 'POST');

  const initialized = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'x-api-key': 'mcp-secret' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'copilot-studio', version: '1' } } })
  });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, 'clean-nano-ai-bridge');
});


test('MCP認証はX-API-Key・Bearer・queryの同一秘密値を受け付ける', async (t) => {
  const server = await createTestServer([], { mcpApiKey: 'mcp-secret' });
  t.after(() => server.close());

  const request = async (url, headers = {}) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'health_check', arguments: {} } })
  });

  for (const response of [
    await request(`${server.baseUrl}/mcp`, { 'x-api-key': 'mcp-secret' }),
    await request(`${server.baseUrl}/mcp`, { authorization: 'Bearer mcp-secret' }),
    await request(`${server.baseUrl}/mcp?x-api-key=mcp-secret`),
    await request(`${server.baseUrl}/mcp?api_key=mcp-secret`)
  ]) {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.isError, false);
    assert.equal(body.result.structuredContent.status, 'ok');
  }

  assert.equal((await request(`${server.baseUrl}/mcp?api_key=wrong`)).status, 401);
});


test('get_sharepoint_columnsは列内部名・表示名・型・Choice候補を読み取り専用で取得できる', async (t) => {
  const mockFetch = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('/lists?')) {
      return new Response(JSON.stringify({ value: [{ id: 'list-1', displayName: 'CN_電子日報台帳' }] }), { status: 200 });
    }
    if (url.includes('/columns')) {
      return new Response(JSON.stringify({ value: [
        { id: 'c1', name: 'WorkDate', displayName: '作業日', required: true, dateTime: { format: 'dateOnly' } },
        { id: 'c2', name: 'SubmissionStatus', displayName: '提出状態', required: false, choice: { choices: ['下書き', '提出済'], allowTextEntry: false } }
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    sharepointOverrides: { fetchImpl: mockFetch }
  });
  t.after(() => server.close());
  const called = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' },
    body: JSON.stringify({ method: 'get_sharepoint_columns', params: { listName: 'CN_電子日報台帳' } })
  });
  assert.equal(called.status, 200);
  const body = await called.json();
  assert.equal(body.result.status, 'ok');
  assert.equal(body.result.columns[0].name, 'WorkDate');
  assert.equal(body.result.columns[0].type, 'dateTime');
  assert.deepEqual(body.result.columns[1].choices, ['下書き', '提出済']);
});

// =====================================================================
// 追加9ツール（validate_powerapps_change / run_powerapps_tests / verify_save_result /
// deploy_to_test / verify_deployment / get_deployment_logs / rollback_deployment /
// get_permissions / update_permissions）
// =====================================================================

const NEW_TOOL_NAMES = [
  'validate_powerapps_change', 'run_powerapps_tests', 'verify_save_result',
  'deploy_to_test', 'verify_deployment', 'get_deployment_logs', 'rollback_deployment',
  'get_permissions', 'update_permissions'
];
const LEGACY_18_TOOL_NAMES = [
  'health_check', 'get_tasks', 'get_next_task', 'create_task', 'update_task_status', 'get_task_result',
  'get_powerapps_app', 'get_powerapps_state', 'get_powerapps_source', 'update_powerapps_app',
  'save_powerapps_app', 'publish_powerapps_app', 'get_sharepoint_list', 'get_sharepoint_columns',
  'ensure_sharepoint_columns', 'run_power_automate_flow', 'create_employee_ledger_entry', 'update_employee_ledger_entry'
];
const MCP_HEADERS = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };
const FALLBACK_BRANCH = 'sync/cn-aiiraidaicho-live-review-20260926';
const GITHUB_ROOT = 'powerapps/app/Source';
const TEST_BASE_URL = 'https://bridge-test.example.com';
const SHA40 = 'c'.repeat(40);
const USER_GUID = '11111111-1111-1111-1111-111111111111';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** [判定関数, 応答生成関数] のリストから、呼び出しを記録するfetchモックを作る。 */
function routedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    // 認証トークン要求はapplication/x-www-form-urlencodedなので、JSONとして解析できる場合だけ解析する。
    let body = null;
    if (options.body) {
      try { body = JSON.parse(options.body); } catch { body = String(options.body); }
    }
    const call = { url: String(url), method: options.method || 'GET', body };
    calls.push(call);
    for (const [matches, respond] of routes) if (matches(call)) return respond(call);
    return jsonResponse({ message: `unexpected request: ${call.method} ${call.url}` }, 599);
  };
  return { calls, fetchImpl };
}

const tokenRoute = [(c) => c.url.includes('/oauth2/v2.0/token'), () => jsonResponse({ access_token: 'mock-token', expires_in: 3600 })];

/** GitHub Contents APIモック。branches = { branch: { 'full/path': content } } */
function githubContentsRoute(branches) {
  return [
    (c) => c.url.includes('api.github.com') && c.method === 'GET' && c.url.includes('/contents/'),
    (c) => {
      const parsed = new URL(c.url);
      const ref = parsed.searchParams.get('ref');
      const filePath = decodeURIComponent(parsed.pathname.split('/contents/')[1]);
      const content = branches[ref]?.[filePath];
      if (content === undefined) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({ type: 'file', sha: `sha-${ref}-${filePath}`, content: Buffer.from(content).toString('base64') });
    }
  ];
}
const githubPutRoute = [
  (c) => c.url.includes('api.github.com') && c.method === 'PUT',
  () => jsonResponse({ commit: { sha: 'commit-sha' }, content: { sha: 'content-sha' } })
];

const gitOverrides = (extra = {}) => ({
  githubToken: 'github-token', githubOwner: 'owner', githubRepo: 'repo', githubBranch: 'main', githubRoot: GITHUB_ROOT, ...extra
});

async function rpc(server, name, args = {}) {
  const response = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  const body = await response.json();
  return { httpStatus: response.status, ...body.result, jsonrpc: body.jsonrpc };
}

async function legacy(server, method, params = {}) {
  const response = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify({ method, params }) });
  return { httpStatus: response.status, body: await response.json() };
}

const newServer = (t, options = {}) => createTestServer([seedTask], { mcpApiKey: 'mcp-secret', ...options }).then((server) => {
  t.after(() => server.close());
  return server;
});

// ---- 登録状態・tools/list・スキーマ ----

test('MCP_METHODSとMCP_PUBLIC_TOOLSの登録が一致し、新29ツール（拡張機能+ユーザー保護）を含む', () => {
  const publicNames = MCP_PUBLIC_TOOLS.map((tool) => tool.name);
  assert.deepEqual([...publicNames].sort(), [...MCP_METHODS].sort());
  assert.equal(new Set(publicNames).size, publicNames.length, '重複登録なし');
  for (const name of [...NEW_TOOL_NAMES, 'get_powerapps_operation_result', 'get_bridge_capabilities', 'check_dependencies', 'compare_powerapps_with_git', 'validate_powerapps_source', 'get_sharepoint_list_schema', 'list_registered_power_automate_flows', 'get_power_automate_run_result', 'inspect_powerapps_structure', 'list_power_apps', 'list_environments', 'list_git_branches', 'get_application_rules', 'export_knowledge_snapshot', 'resolve_app_target', 'lock_user_info', 'validate_passkey', 'get_user_lock_status', 'can_view_user_info', 'can_edit_user_info', 'can_delete_user_info', 'generate_ui_control_state']) assert.ok(publicNames.includes(name), name);
  assert.equal(publicNames.length, MCP_PUBLIC_TOOLS.length);
  assert.deepEqual(publicNames.slice(0, 18), LEGACY_18_TOOL_NAMES, '既存18ツールは名前・順序とも不変');
});

test('tools/list（REST・JSON-RPC）に新9ツールが含まれ、inputSchemaはadditionalProperties:falseで厳密', async (t) => {
  const server = await newServer(t);
  const rest = await (await fetch(`${server.baseUrl}/mcp/tools/list`, { headers: { 'x-api-key': 'mcp-secret' } })).json();
  const rpcList = await (await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers: MCP_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })
  })).json();
  for (const tools of [rest.tools, rpcList.result.tools]) {
    const names = tools.map((tool) => tool.name);
    for (const name of NEW_TOOL_NAMES) assert.ok(names.includes(name), name);
    for (const tool of tools.filter((entry) => NEW_TOOL_NAMES.includes(entry.name))) {
      assert.equal(typeof tool.description, 'string', tool.name);
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    }
  }
  const byName = Object.fromEntries(rest.tools.map((tool) => [tool.name, tool.inputSchema]));
  assert.equal(byName.run_powerapps_tests.properties.files.items.additionalProperties, false);
  assert.deepEqual(byName.update_permissions.required.sort(), ['action', 'approvedByHuman', 'principalId', 'principalType', 'roleName', 'targetType']);
  assert.deepEqual(byName.get_permissions.properties.targetType.enum, ['powerapps_app', 'dataverse_user_roles']);
});

test('新9ツールは入力不足・不正型・追加プロパティをHTTP 200 + isError:true（legacyは400）で拒否する', async (t) => {
  const server = await newServer(t);
  const cases = [
    ['validate_powerapps_change', {}, /branchが必要/],
    ['validate_powerapps_change', { branch: 1, relativePath: 'a.pa.yaml' }, /branchが必要/],
    ['validate_powerapps_change', { branch: 'main', relativePath: 'a.pa.yaml', content: 5 }, /contentは文字列/],
    ['validate_powerapps_change', { branch: 'main', relativePath: 'a.pa.yaml', unexpected: true }, /未対応のプロパティ/],
    ['run_powerapps_tests', {}, /filesは1件以上/],
    ['run_powerapps_tests', { files: [{ relativePath: 'a.pa.yaml' }] }, /content.*delete:true/],
    ['run_powerapps_tests', { files: [{ relativePath: 'a.pa.yaml', content: 'x', extra: 1 }] }, /未対応のプロパティ/],
    ['run_powerapps_tests', { files: 'a' }, /filesは1件以上/],
    ['verify_save_result', { relativePath: 'a.pa.yaml' }, /expectedShaまたはexpectedContent/],
    ['verify_save_result', { relativePath: 'a.pa.yaml', expectedSha: 'short' }, /40桁/],
    ['verify_save_result', { expectedContent: 'x' }, /relativePathが必要/],
    ['deploy_to_test', {}, /branchが必要/],
    ['deploy_to_test', { branch: 'main', ref: 'not-a-sha' }, /コミットSHA/],
    ['deploy_to_test', { branch: 'main', production: true }, /未対応のプロパティ/],
    ['verify_deployment', { expectedVersion: 1 }, /expectedVersion/],
    ['verify_deployment', { surprise: 1 }, /未対応のプロパティ/],
    ['get_deployment_logs', { limit: 99 }, /limit/],
    ['get_deployment_logs', { runId: 'abc' }, /runId/],
    ['get_deployment_logs', { runId: 1, deploymentId: 'x' }, /同時に指定できません/],
    ['rollback_deployment', {}, /targetDeploymentIdが必要/],
    ['rollback_deployment', { targetDeploymentId: 'x', approvedByHuman: 'yes' }, /approvedByHuman/],
    ['get_permissions', {}, /targetType/],
    ['get_permissions', { targetType: 'everything' }, /targetType/],
    ['get_permissions', { targetType: 'dataverse_user_roles' }, /principalId/],
    ['update_permissions', { targetType: 'powerapps_app', action: 'grant', principalId: USER_GUID, principalType: 'User', roleName: 'CanView' }, /approvedByHuman:true/],
    ['update_permissions', { targetType: 'powerapps_app', action: 'grant', principalId: USER_GUID, principalType: 'User', roleName: 'CanView', approvedByHuman: 'true' }, /approvedByHuman:true/],
    ['update_permissions', { targetType: 'powerapps_app', action: 'merge', principalId: USER_GUID, principalType: 'User', roleName: 'CanView', approvedByHuman: true }, /action/],
    ['update_permissions', { targetType: 'powerapps_app', action: 'grant', principalId: USER_GUID, principalType: 'Robot', roleName: 'CanView', approvedByHuman: true }, /principalType/],
    ['update_permissions', { targetType: 'powerapps_app', action: 'grant', principalId: USER_GUID, principalType: 'User', roleName: 'CanView', approvedByHuman: true, admin: true }, /未対応のプロパティ/]
  ];
  for (const [name, args, pattern] of cases) {
    const viaRpc = await rpc(server, name, args);
    assert.equal(viaRpc.httpStatus, 200, name);
    assert.equal(viaRpc.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(viaRpc.structuredContent.error, pattern, name);
    const viaLegacy = await legacy(server, name, args);
    assert.equal(viaLegacy.httpStatus, 400, name);
    assert.match(viaLegacy.body.error, pattern, name);
  }
});

// ---- validate_powerapps_change / run_powerapps_tests ----

test('validate_powerapps_change: 正本branchの現在内容と比較し、valid・errors・warnings・summaryを返す（JSON-RPC・legacy）', async (t) => {
  const mock = routedFetch([githubContentsRoute({ main: { [`${GITHUB_ROOT}/Screen3.pa.yaml`]: 'a: 1\nb: 2\n' } })]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: gitOverrides() });

  const ok = await rpc(server, 'validate_powerapps_change', { branch: 'main', relativePath: 'Screen3.pa.yaml', content: 'a: 1\nb: 3\n' });
  assert.equal(ok.isError, false);
  assert.equal(ok.structuredContent.valid, true);
  assert.deepEqual(Object.keys(ok.structuredContent).sort(), ['errors', 'summary', 'valid', 'warnings']);
  assert.equal(ok.structuredContent.summary.diffChecked, true);
  assert.equal(ok.structuredContent.summary.canonicalBranch, 'main');

  const mismatch = await rpc(server, 'validate_powerapps_change', { branch: FALLBACK_BRANCH, relativePath: 'Screen3.pa.yaml', content: 'a: 1\n' });
  assert.equal(mismatch.isError, false, '検証結果はvalid:falseで返す（ツール自体は成功）');
  assert.equal(mismatch.structuredContent.valid, false);
  assert.ok(mismatch.structuredContent.errors.some((e) => e.includes('branch不一致')));

  const viaLegacy = await legacy(server, 'validate_powerapps_change', { branch: 'main', relativePath: 'Screen3.pa.yaml', content: 'a: 9\n' });
  assert.equal(viaLegacy.httpStatus, 200);
  assert.equal(viaLegacy.body.accepted, true);
  assert.equal(viaLegacy.body.method, 'validate_powerapps_change');
  assert.equal(typeof viaLegacy.body.result.valid, 'boolean');
});

test('validate_powerapps_change: 対象不存在は拒否し、フォールバックbranchでのみ見つかる場合は更新不可と判定する', async (t) => {
  const mock = routedFetch([githubContentsRoute({ [FALLBACK_BRANCH]: { [`${GITHUB_ROOT}/OnlyOld.pa.yaml`]: 'a: 1\n' } })]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: gitOverrides() });

  const missing = await rpc(server, 'validate_powerapps_change', { branch: 'main', relativePath: 'Nope.pa.yaml', content: 'a: 1\n' });
  assert.equal(missing.structuredContent.valid, false);
  assert.ok(missing.structuredContent.errors.some((e) => e.includes('存在しません')));

  const created = await rpc(server, 'validate_powerapps_change', { branch: 'main', relativePath: 'Nope.pa.yaml', content: 'a: 1\n', create: true });
  assert.equal(created.structuredContent.valid, true);
  assert.equal(created.structuredContent.summary.operation, 'create');

  const old = await rpc(server, 'validate_powerapps_change', { branch: 'main', relativePath: 'OnlyOld.pa.yaml', content: 'a: 2\n' });
  assert.equal(old.structuredContent.valid, false);
  assert.ok(old.structuredContent.errors.some((e) => e.includes(FALLBACK_BRANCH)));
});

test('validate_powerapps_change: GitHub設定不足でも落とさず、差分未検査を警告する／currentContent指定時は取得しない', async (t) => {
  const server = await newServer(t);
  const noGit = await rpc(server, 'validate_powerapps_change', { branch: 'main', relativePath: 'a.pa.yaml', content: 'a: 1\n' });
  assert.equal(noGit.isError, false);
  assert.equal(noGit.structuredContent.summary.diffChecked, false);
  assert.ok(noGit.structuredContent.warnings.some((w) => w.includes('GitHub設定が不足')));
  const provided = await rpc(server, 'validate_powerapps_change', { branch: 'main', relativePath: 'a.pa.yaml', currentContent: 'a: 0\n', content: 'a: 1\n' });
  assert.equal(provided.structuredContent.valid, true);
  assert.equal(provided.structuredContent.summary.diffChecked, true);
});

test('validate_powerapps_change: 上流500は502相当のエラー（isError:true）で、GitHub 404以外は握りつぶさない', async (t) => {
  const mock = routedFetch([[(c) => c.url.includes('/contents/'), () => jsonResponse({ message: 'boom' }, 500)]]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: gitOverrides() });
  const failed = await rpc(server, 'validate_powerapps_change', { branch: 'main', relativePath: 'a.pa.yaml', content: 'a: 1\n' });
  assert.equal(failed.isError, true);
  assert.match(failed.structuredContent.error, /GitHub API エラー \(500\)/);
});

test('run_powerapps_tests: 静的検査を実行し、未検証項目はskipped+reasonで返す（成功扱いにしない）', async (t) => {
  const server = await newServer(t);
  const files = [{ relativePath: 'Screen1.pa.yaml', content: 'Screens:\n  Screen1:\n    Properties:\n      OnVisible: =Navigate(Screen9)\n      Fill: =If(true, RGBA(0, 0, 0, 1)\n' }];
  const failing = await rpc(server, 'run_powerapps_tests', { files, knownScreens: ['Screen1'] });
  assert.equal(failing.isError, false);
  assert.equal(failing.structuredContent.status, 'failed');
  assert.equal(failing.structuredContent.checks.find((c) => c.id === 'brackets').status, 'failed');
  assert.equal(failing.structuredContent.checks.find((c) => c.id === 'screen_transitions').status, 'failed');

  const clean = await rpc(server, 'run_powerapps_tests', { files: [{ relativePath: 'Screen1.pa.yaml', content: 'Screens:\n  Screen1:\n    Properties:\n      Fill: =RGBA(0, 0, 0, 1)\n' }] });
  assert.equal(clean.structuredContent.status, 'incomplete');
  const engine = clean.structuredContent.checks.find((c) => c.id === 'power_apps_test_engine');
  assert.equal(engine.status, 'skipped');
  assert.ok(engine.reason);

  const viaLegacy = await legacy(server, 'run_powerapps_tests', { files: [{ relativePath: 'a.json', content: '{}' }] });
  assert.equal(viaLegacy.httpStatus, 200);
  assert.equal(viaLegacy.body.result.scope, 'static_analysis');
});

// ---- verify_save_result ----

test('verify_save_result: 正本ソースとアプリ状態が期待どおりならverified、保存未反映ならverified:false', async (t) => {
  const path = `${GITHUB_ROOT}/Screen3.pa.yaml`;
  const mock = routedFetch([
    tokenRoute,
    githubContentsRoute({ main: { [path]: 'saved content' } }),
    [(c) => c.url.includes('/apps/test-app'), () => jsonResponse({ properties: { displayName: 'Test App', appVersion: '2.0' } })]
  ]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: gitOverrides() });

  const verified = await rpc(server, 'verify_save_result', { relativePath: 'Screen3.pa.yaml', branch: 'main', expectedContent: 'saved content' });
  assert.equal(verified.isError, false);
  assert.equal(verified.structuredContent.status, 'verified');
  assert.equal(verified.structuredContent.verified, true);
  assert.ok(verified.structuredContent.checks.every((c) => c.status === 'passed'));

  const notSaved = await rpc(server, 'verify_save_result', { relativePath: 'Screen3.pa.yaml', expectedContent: 'content that was not saved' });
  assert.equal(notSaved.isError, false);
  assert.equal(notSaved.structuredContent.verified, false);
  assert.ok(notSaved.structuredContent.errors.some((e) => e.includes('保存未反映')));

  const wrongBranch = await rpc(server, 'verify_save_result', { relativePath: 'Screen3.pa.yaml', branch: FALLBACK_BRANCH, expectedContent: 'saved content' });
  assert.equal(wrongBranch.structuredContent.verified, false);

  const missing = await rpc(server, 'verify_save_result', { relativePath: 'Gone.pa.yaml', expectedContent: 'x' });
  assert.equal(missing.structuredContent.verified, false);
  assert.ok(missing.structuredContent.errors.some((e) => e.includes('対象不存在')));
});

test('verify_save_result: GitHub設定不足はnot_configured（isError:true、legacyは503）', async (t) => {
  const server = await newServer(t);
  const result = await rpc(server, 'verify_save_result', { relativePath: 'a.pa.yaml', expectedContent: 'x' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'not_configured');
  assert.ok(result.structuredContent.missingConfiguration.includes('POWERAPPS_GITHUB_TOKEN'));
  assert.equal(typeof result.structuredContent.reason, 'string');
  const viaLegacy = await legacy(server, 'verify_save_result', { relativePath: 'a.pa.yaml', expectedContent: 'x' });
  assert.equal(viaLegacy.httpStatus, 503);
  assert.equal(viaLegacy.body.status, 'not_configured');
});

// ---- デプロイ系 ----

const deployConfig = (extra = {}) => ({
  githubToken: `ghp_${'t'.repeat(30)}`, githubOwner: 'owner', githubRepo: 'repo', allowedBranches: ['main'],
  testWorkflow: 'deploy-test.yml', testEnvironmentName: 'test', testBaseUrl: TEST_BASE_URL, ...extra
});
const dispatchRoute = [(c) => c.method === 'POST' && c.url.includes('/dispatches'), () => new Response(null, { status: 204 })];
const commitRoute = [(c) => c.url.includes('/commits/'), () => jsonResponse({ sha: SHA40 })];

test('deploy_to_test: 未構成はダミー成功にせず、status・reason・missingConfigurationを返す（isError:true / legacy 503）', async (t) => {
  const server = await newServer(t);
  const result = await rpc(server, 'deploy_to_test', { branch: 'main' });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'not_configured');
  assert.equal(typeof result.structuredContent.reason, 'string');
  for (const name of ['DEPLOY_GITHUB_TOKEN', 'DEPLOY_TEST_WORKFLOW', 'DEPLOY_TEST_ENVIRONMENT_NAME']) {
    assert.ok(result.structuredContent.missingConfiguration.includes(name), name);
  }
  const viaLegacy = await legacy(server, 'deploy_to_test', { branch: 'main' });
  assert.equal(viaLegacy.httpStatus, 503);
  assert.deepEqual(Object.keys(viaLegacy.body).filter((k) => ['status', 'reason', 'missingConfiguration'].includes(k)).sort(), ['missingConfiguration', 'reason', 'status']);
});

test('deploy_to_test: 構成済みテスト環境へdispatchでき、本番・環境不明・branch不一致は拒否する', async (t) => {
  const mock = routedFetch([commitRoute, dispatchRoute]);
  const server = await newServer(t, {
    fetchImpl: mock.fetchImpl,
    deploymentOverrides: deployConfig({ productionWorkflow: 'deploy-prod.yml', productionEnvironmentName: 'production', productionBaseUrl: 'https://bridge.example.com' })
  });

  const ok = await rpc(server, 'deploy_to_test', { branch: 'main' });
  assert.equal(ok.isError, false);
  assert.equal(ok.structuredContent.status, 'dispatched');
  assert.equal(ok.structuredContent.environment, 'test');
  assert.equal(mock.calls.filter((c) => c.url.includes('/dispatches')).length, 1);
  const before = mock.calls.length;

  const production = await rpc(server, 'deploy_to_test', { branch: 'main', environment: 'production' });
  assert.equal(production.isError, true);
  assert.equal(production.structuredContent.reason, 'production_environment_not_allowed');
  const unknown = await rpc(server, 'deploy_to_test', { branch: 'main', environment: 'qa-9' });
  assert.equal(unknown.structuredContent.reason, 'unknown_environment');
  const wrongBranch = await rpc(server, 'deploy_to_test', { branch: FALLBACK_BRANCH });
  assert.equal(wrongBranch.structuredContent.status, 'branch_mismatch');
  assert.equal(mock.calls.length, before, '拒否したリクエストは外部通信しない');

  const viaLegacy = await legacy(server, 'deploy_to_test', { branch: 'main', environment: 'production' });
  assert.equal(viaLegacy.httpStatus, 403);
});

for (const status of [404, 409, 429, 500]) {
  test(`deploy_to_test: 上流${status}はHTTP 200 + isError:trueでdetails.httpStatusを返す（legacyは502）`, async (t) => {
    const mock = routedFetch([commitRoute, [(c) => c.url.includes('/dispatches'), () => jsonResponse({ message: 'upstream said no' }, status)]]);
    const server = await newServer(t, { fetchImpl: mock.fetchImpl, deploymentOverrides: deployConfig() });
    const result = await rpc(server, 'deploy_to_test', { branch: 'main' });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.details.httpStatus, status);
    const viaLegacy = await legacy(server, 'deploy_to_test', { branch: 'main' });
    assert.equal(viaLegacy.httpStatus, 502);
    assert.equal(viaLegacy.body.details.httpStatus, status);
  });
}

test('verify_deployment / get_deployment_logs / rollback_deployment: サーバー経由でdeploy→verify→rollbackと診断ログ取得が動く', async (t) => {
  const run = { id: 5, run_number: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_branch: 'main', head_sha: SHA40, created_at: new Date(Date.now() + 5000).toISOString(), html_url: 'u' };
  const mock = routedFetch([
    commitRoute, dispatchRoute,
    [(c) => c.url === `${TEST_BASE_URL}/health`, () => jsonResponse({ status: 'ok', version: '1.0.0' })],
    [(c) => /\/workflows\/[^/]+\/runs/.test(c.url), () => jsonResponse({ workflow_runs: [run] })],
    [(c) => /\/runs\/5\/jobs/.test(c.url), () => jsonResponse({ jobs: [{ id: 1, name: 'deploy', status: 'completed', conclusion: 'success', steps: [] }] })]
  ]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, deploymentOverrides: deployConfig() });

  const deployed = await rpc(server, 'deploy_to_test', { branch: 'main' });
  const { deploymentId } = deployed.structuredContent;
  const verified = await rpc(server, 'verify_deployment', { deploymentId, expectedVersion: '1.0.0' });
  assert.equal(verified.isError, false);
  assert.equal(verified.structuredContent.status, 'verified');
  assert.equal(verified.structuredContent.health.httpStatus, 200);

  const logs = await rpc(server, 'get_deployment_logs', { deploymentId });
  assert.equal(logs.structuredContent.status, 'ok');
  assert.equal(logs.structuredContent.masked, true);
  assert.equal(logs.structuredContent.jobs[0].name, 'deploy');

  const rolledBack = await rpc(server, 'rollback_deployment', { targetDeploymentId: deploymentId });
  assert.equal(rolledBack.isError, false);
  assert.equal(rolledBack.structuredContent.status, 'ok');
  assert.equal(rolledBack.structuredContent.healthVerified, true);

  const unknownSource = await rpc(server, 'rollback_deployment', { targetDeploymentId: 'does-not-exist' });
  assert.equal(unknownSource.isError, true);
  assert.equal(unknownSource.structuredContent.status, 'rollback_source_not_found');
  const legacyUnknown = await legacy(server, 'rollback_deployment', { targetDeploymentId: 'does-not-exist' });
  assert.equal(legacyUnknown.httpStatus, 404);
});

test('verify_deployment: healthが異常ならfailed（HTTP状態と応答内容を返す）', async (t) => {
  const mock = routedFetch([[(c) => c.url === `${TEST_BASE_URL}/health`, () => jsonResponse({ status: 'down', detail: `Bearer ${'z'.repeat(20)}` }, 503)]]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, deploymentOverrides: deployConfig() });
  const result = await rpc(server, 'verify_deployment', {});
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.status, 'failed');
  assert.equal(result.structuredContent.health.httpStatus, 503);
  assert.equal(result.structuredContent.health.body.status, 'down');
  assert.ok(!JSON.stringify(result.structuredContent).includes('z'.repeat(20)), 'health応答中の秘密値はマスクされる');
});

test('rollback_deployment: 本番はapprovedByHuman:trueが無ければ拒否（isError:true）', async (t) => {
  const mock = routedFetch([]);
  const server = await newServer(t, {
    fetchImpl: mock.fetchImpl,
    deploymentOverrides: deployConfig({ productionWorkflow: 'deploy-prod.yml', productionEnvironmentName: 'production', productionBaseUrl: 'https://bridge.example.com' })
  });
  const result = await rpc(server, 'rollback_deployment', { environment: 'production', targetDeploymentId: 'any' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'approval_required');
  assert.equal(mock.calls.length, 0);
  const viaLegacy = await legacy(server, 'rollback_deployment', { environment: 'production', targetDeploymentId: 'any', approvedByHuman: false });
  assert.equal(viaLegacy.httpStatus, 403);
});

// ---- 権限系 ----

test('get_permissions: 構成済みアプリの権限を読み取り専用で取得する', async (t) => {
  const mock = routedFetch([
    tokenRoute,
    [(c) => c.url.includes('/apps/test-app/permissions'), () => jsonResponse({ value: [{ name: 'p1', properties: { principal: { id: USER_GUID, type: 'User', email: 'a@example.com' }, roleName: 'CanView' } }], secret: 'nope' })]
  ]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl });
  const result = await rpc(server, 'get_permissions', { targetType: 'powerapps_app' });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.targetType, 'powerapps_app');
  assert.equal(result.structuredContent.scope.appId, 'test-app');
  assert.equal(result.structuredContent.permissions[0].roleName, 'CanView');
  assert.ok(!JSON.stringify(result.structuredContent).includes('nope'));
  assert.ok(mock.calls.every((c) => c.method === 'GET' || c.url.includes('/oauth2/')), '読み取り専用');
});

test('get_permissions: 設定不足はnot_configured／上流エラーは502相当で詳細を返す', async (t) => {
  const unconfigured = await newServer(t, { powerAppsOverrides: { appId: '' } });
  const missing = await rpc(unconfigured, 'get_permissions', { targetType: 'powerapps_app' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.status, 'not_configured');
  assert.ok(missing.structuredContent.missingConfiguration.includes('POWERAPPS_APP_ID'));

  for (const status of [404, 409, 429, 500]) {
    const mock = routedFetch([tokenRoute, [(c) => c.url.includes('/permissions'), () => jsonResponse({ error: { code: 'X', message: 'nope' } }, status)]]);
    const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: { cacheTtlMs: 1 } });
    const result = await rpc(server, 'get_permissions', { targetType: 'powerapps_app' });
    assert.equal(result.isError, true, String(status));
    assert.equal(result.structuredContent.details.httpStatus, status);
  }
});

test('update_permissions: 承認済みの最小権限は付与でき、強い権限・テナント共有は承認済みでも拒否する', async (t) => {
  const permissions = [];
  const mock = routedFetch([
    tokenRoute,
    [(c) => c.url.includes('/modifyPermissions'), (c) => {
      for (const put of c.body.put || []) permissions.push({ name: 'new', properties: put.properties });
      return jsonResponse({});
    }],
    [(c) => c.url.includes('/apps/test-app/permissions'), () => jsonResponse({ value: permissions })]
  ]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl });
  const base = { targetType: 'powerapps_app', action: 'grant', principalId: USER_GUID, principalType: 'User', approvedByHuman: true };

  const granted = await rpc(server, 'update_permissions', { ...base, roleName: 'CanView' });
  assert.equal(granted.isError, false);
  assert.equal(granted.structuredContent.verified, true);
  assert.equal(granted.structuredContent.before.length, 0);
  assert.equal(granted.structuredContent.after.length, 1);

  const writesBefore = mock.calls.filter((c) => c.url.includes('/modifyPermissions')).length;
  const owner = await rpc(server, 'update_permissions', { ...base, roleName: 'Owner' });
  assert.equal(owner.isError, true);
  assert.equal(owner.structuredContent.reason, 'strong_permission');
  const tenant = await rpc(server, 'update_permissions', { ...base, roleName: 'CanView', principalType: 'Tenant', principalId: 'tenant' });
  assert.equal(tenant.structuredContent.reason, 'environment_wide_share');
  const external = await rpc(server, 'update_permissions', { ...base, roleName: 'CanView', principalId: 'guest#EXT#@x.onmicrosoft.com' });
  assert.equal(external.structuredContent.reason, 'external_share');
  assert.equal(mock.calls.filter((c) => c.url.includes('/modifyPermissions')).length, writesBefore, '拒否した要求では書き込まない');
  assert.equal((await legacy(server, 'update_permissions', { ...base, roleName: 'Owner' })).httpStatus, 403);
});

test('update_permissions: Dataverseの強い権限（System Administrator）は拒否し、許可リスト未構成はnot_configured', async (t) => {
  const mock = routedFetch([tokenRoute]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: { orgUrl: 'https://org.crm.dynamics.com' } });
  const base = { targetType: 'dataverse_user_roles', action: 'grant', principalId: USER_GUID, principalType: 'User', approvedByHuman: true };
  const strong = await rpc(server, 'update_permissions', { ...base, roleName: 'System Administrator' });
  assert.equal(strong.isError, true);
  assert.equal(strong.structuredContent.reason, 'strong_permission');
  const unconfigured = await rpc(server, 'update_permissions', { ...base, roleName: 'Basic User' });
  assert.equal(unconfigured.structuredContent.status, 'not_configured');
  assert.ok(unconfigured.structuredContent.missingConfiguration.includes('PERMISSIONS_ALLOWED_DATAVERSE_ROLES'));
  assert.equal(mock.calls.length, 0);
});

// ---- 安全修正: 過去branchへの更新・保存・公開の拒否 ----

test('update_powerapps_app: フォールバック（過去）branchでしか見つからないソースは更新を拒否し、PUTしない', async (t) => {
  const mock = routedFetch([githubContentsRoute({ [FALLBACK_BRANCH]: { [`${GITHUB_ROOT}/Screen3.pa.yaml`]: 'old' } }), githubPutRoute]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: gitOverrides() });
  const args = { relativePath: 'Screen3.pa.yaml', content: 'new', message: 'm', branch: 'main' };

  const viaRpc = await rpc(server, 'update_powerapps_app', args);
  assert.equal(viaRpc.httpStatus, 200);
  assert.equal(viaRpc.isError, true);
  assert.equal(viaRpc.structuredContent.status, 'branch_mismatch');
  assert.match(viaRpc.structuredContent.error, new RegExp(FALLBACK_BRANCH));
  const viaLegacy = await legacy(server, 'update_powerapps_app', args);
  assert.equal(viaLegacy.httpStatus, 409);
  assert.equal(mock.calls.filter((c) => c.method === 'PUT').length, 0, '過去branchへ書き込まない');
});

test('update_powerapps_app: get_powerapps_sourceが返したbranchを渡し、正本と異なれば通信前に拒否する／正本なら更新できる', async (t) => {
  const mock = routedFetch([
    githubContentsRoute({ main: { [`${GITHUB_ROOT}/Screen3.pa.yaml`]: 'old' } }), githubPutRoute, tokenRoute,
    [(c) => c.url.includes('/solutions?'), () => jsonResponse({ value: [{ uniquename: 'S' }] })],
    [(c) => c.url.endsWith('RefreshChangesFromGit') || c.url.endsWith('PullChangesFromGit'), () => jsonResponse({})]
  ]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: gitOverrides({ orgUrl: 'https://org.crm.dynamics.com', solutionUniqueName: 'S' }) });

  const refused = await rpc(server, 'update_powerapps_app', { relativePath: 'Screen3.pa.yaml', content: 'new', branch: FALLBACK_BRANCH });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.status, 'branch_mismatch');
  assert.equal(mock.calls.length, 0);

  const accepted = await rpc(server, 'update_powerapps_app', { relativePath: 'Screen3.pa.yaml', content: 'new', branch: 'main' });
  assert.equal(accepted.isError, false);
  assert.equal(accepted.structuredContent.update.branch, 'main');
  assert.equal(mock.calls.find((c) => c.method === 'PUT').body.branch, 'main');
});

test('save_powerapps_app / publish_powerapps_app: State Lock未成立・branch不一致を拒否し、正本一致のみ実行する', async (t) => {
  const mock = routedFetch([
    tokenRoute,
    [(c) => c.url.includes('/solutions?'), () => jsonResponse({ value: [{ solutionid: '1', uniquename: 'ActualSolution', friendlyname: 'A', version: '1', ismanaged: false }] })],
    [(c) => c.url.endsWith('RefreshChangesFromGit') || c.url.endsWith('PullChangesFromGit'), () => jsonResponse({ ok: true })],
    [(c) => c.url.includes('/canvasapps('), () => jsonResponse({ displayname: 'Test App', appversion: '1.1' })],
    [(c) => c.url.includes('/apps/test-app/publish'), () => jsonResponse({})],
    [(c) => c.url.includes('/apps/test-app'), () => jsonResponse({ properties: { displayName: 'Test App', appVersion: '1.1' } })]
  ]);
  const server = await newServer(t, {
    fetchImpl: mock.fetchImpl,
    powerAppsOverrides: gitOverrides({ orgUrl: 'https://example.crm.dynamics.com', solutionUniqueName: 'CN_CompanyOS' })
  });
  const sideEffects = () => mock.calls.filter((c) => c.url.endsWith('RefreshChangesFromGit') || c.url.endsWith('PullChangesFromGit') || c.url.includes('/publish')).length;

  const saveRefused = await rpc(server, 'save_powerapps_app', { branch: FALLBACK_BRANCH });
  assert.equal(saveRefused.isError, true);
  assert.equal(saveRefused.structuredContent.status, 'branch_mismatch');
  const publishRefused = await rpc(server, 'publish_powerapps_app', { branch: FALLBACK_BRANCH });
  assert.equal(publishRefused.isError, true);
  assert.equal(publishRefused.structuredContent.status, 'branch_mismatch');
  assert.equal((await legacy(server, 'publish_powerapps_app', { branch: FALLBACK_BRANCH })).httpStatus, 409);
  assert.equal(sideEffects(), 0, '拒否時は同期も公開も実行しない');

  const saveOk = await rpc(server, 'save_powerapps_app', { branch: 'main' });
  assert.equal(saveOk.isError, false);
  const saveUnlocked = await rpc(server, 'save_powerapps_app', {});
  assert.equal(saveUnlocked.isError, true, 'branch未指定はState Lock未成立として拒否');
  assert.equal(saveUnlocked.structuredContent.status, 'branch_mismatch');
  const publishOk = await rpc(server, 'publish_powerapps_app', { branch: 'main' });
  assert.equal(publishOk.isError, false);
  assert.equal(publishOk.structuredContent.status, 'ok');
  assert.equal((await rpc(server, 'publish_powerapps_app', { branch: '' })).isError, true);
});

test('get_powerapps_sourceは取得したbranchと正本branchの一致状況を返す', async (t) => {
  const mock = routedFetch([githubContentsRoute({ [FALLBACK_BRANCH]: { [`${GITHUB_ROOT}/Old.pa.yaml`]: 'x' }, main: { [`${GITHUB_ROOT}/New.pa.yaml`]: 'y' } })]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl, powerAppsOverrides: gitOverrides() });
  const old = await rpc(server, 'get_powerapps_source', { relativePath: 'Old.pa.yaml' });
  assert.equal(old.structuredContent.branch, FALLBACK_BRANCH);
  assert.equal(old.structuredContent.isCanonicalBranch, false);
  assert.equal(old.structuredContent.canonicalBranch, 'main');
  const current = await rpc(server, 'get_powerapps_source', { relativePath: 'New.pa.yaml' });
  assert.equal(current.structuredContent.isCanonicalBranch, true);
});

// ---- get_powerapps_operation_result の登録修正 ----

test('get_powerapps_operation_result: tools/listに登録され、tools/call・legacyの両方で実行できる。失敗は500でなく詳細付きで返る', async (t) => {
  const server = await newServer(t);
  const list = await (await fetch(`${server.baseUrl}/mcp/tools/list`, { headers: { 'x-api-key': 'mcp-secret' } })).json();
  const tool = list.tools.find((entry) => entry.name === 'get_powerapps_operation_result');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['operationId']);
  assert.equal(tool.inputSchema.additionalProperties, false);

  const missingLog = await rpc(server, 'get_powerapps_operation_result', { operationId: 'op-1' });
  assert.equal(missingLog.httpStatus, 200);
  assert.equal(missingLog.isError, true);
  assert.match(missingLog.structuredContent.error, /操作結果取得失敗/);
  const legacyMissing = await legacy(server, 'get_powerapps_operation_result', { operationId: 'op-1' });
  assert.equal(legacyMissing.httpStatus, 502);
  assert.equal((await rpc(server, 'get_powerapps_operation_result', {})).isError, true);
});

test('get_powerapps_operation_result: 記録済みの操作結果を取得でき、未記録のoperationIdはnot_found', async (t) => {
  const mock = routedFetch([
    tokenRoute,
    [(c) => c.url.includes('/apps/test-app'), () => jsonResponse({ properties: { displayName: 'Test App', appVersion: '3.0' } })]
  ]);
  const server = await newServer(t, { fetchImpl: mock.fetchImpl });
  const state = await rpc(server, 'get_powerapps_state', {});
  const operationId = state.structuredContent.operationId;
  const found = await rpc(server, 'get_powerapps_operation_result', { operationId });
  assert.equal(found.isError, false);
  assert.equal(found.structuredContent.operation, 'get_state');
  assert.equal(found.structuredContent.operationStatus, 'success');
  const legacyFound = await legacy(server, 'get_powerapps_operation_result', { operationId });
  assert.equal(legacyFound.body.result.operationId, operationId);
  const unknown = await rpc(server, 'get_powerapps_operation_result', { operationId: 'never-recorded' });
  assert.equal(unknown.structuredContent.status, 'not_found');
});

// ---- 既存ツールの後方互換 ----

test('既存18ツールはtools/callでも引き続き呼び出せる（新ツール追加による回帰なし）', async (t) => {
  const server = await newServer(t);
  for (const name of ['health_check', 'get_tasks', 'get_next_task']) {
    const result = await rpc(server, name, {});
    assert.equal(result.isError, false, name);
  }
  const created = await rpc(server, 'create_task', { title: '後方互換確認' });
  assert.equal(created.isError, false);
  const fetched = await rpc(server, 'get_task_result', { task_id: created.structuredContent.task_id });
  assert.equal(fetched.structuredContent.task_id, created.structuredContent.task_id);
  const unknownTool = await rpc(server, 'does_not_exist', {});
  assert.equal(unknownTool.isError, true);
  assert.match(unknownTool.structuredContent.error, /不明なmethod/);
  const unknownLegacy = await legacy(server, 'does_not_exist', {});
  assert.equal(unknownLegacy.httpStatus, 400);
  for (const name of LEGACY_18_TOOL_NAMES) assert.ok(MCP_METHODS.includes(name), name);
});

test('Executive policy is available through authenticated MCP capabilities without changing health', async (t) => {
  const server = await createTestServer([], { mcpApiKey: 'policy-test-key' });
  t.after(() => server.close());
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'get_bridge_capabilities', arguments: {} } }) };
  const denied = await fetch(`${server.baseUrl}/mcp`, request);
  assert.equal(denied.status, 401);
  request.headers['X-API-Key'] = 'policy-test-key';
  const response = await fetch(`${server.baseUrl}/mcp`, request);
  assert.equal(response.status, 200);
  const body = await response.json();
  const result = JSON.parse(body.result.content[0].text);
  assert.equal(result.data.executivePolicy.systemOfRecord, 'SharePoint Lists');
  assert.deepEqual(result.data.executivePolicy.priorities, ['利益', '入金回収', 'キャッシュフロー', '安全', '品質', '業務効率', '売上']);
  assert.match(result.data.executivePolicy.instructions, /AI単独承認/);
  assert.match(result.data.executivePolicy.instructions, /branch不一致/i);
  assert.deepEqual(await (await fetch(`${server.baseUrl}/health`)).json(), { status: 'ok' });
});



test('MCP public Power Apps write tools expose complete required stateContext schema', () => {
  const writeTools = ['update_powerapps_app', 'save_powerapps_app', 'publish_powerapps_app'];
  const expectedFields = ['appId', 'environment', 'branch', 'canonicalBranch', 'sha', 'correlationId'];

  for (const name of writeTools) {
    const tool = MCP_PUBLIC_TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} must be publicly exposed`);
    assert.ok(tool.inputSchema.required.includes('stateContext'), `${name} must require stateContext`);

    const stateSchema = tool.inputSchema.properties.stateContext;
    assert.equal(stateSchema.additionalProperties, false);
    assert.deepEqual(stateSchema.required, expectedFields);
    assert.deepEqual(Object.keys(stateSchema.properties), expectedFields);
  }
});
