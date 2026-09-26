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

test('save_powerapps_appは実反映と復元の検証がない場合はGit同期を一切実行しない', async (t) => {
  const actions = [];
  const mockFetch = async (url) => {
    if (url.includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith('/RefreshChangesFromGit') || url.endsWith('/PullChangesFromGit')) {
      actions.push(url);
      throw new Error('mutating Git sync must not be called');
    }
    if (url.includes('/solutions?')) {
      return new Response(JSON.stringify({ value: [{
        solutionid: 'solution-1', uniquename: 'ActualSolution',
        friendlyname: 'Actual Solution', version: '1.0.0.0', ismanaged: false
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    fetchImpl: mockFetch,
    powerAppsOverrides: {
      orgUrl: 'https://example.crm.dynamics.com',
      solutionUniqueName: 'ActualSolution',
      sourceAppId: 'test-app', sourceEnvironmentId: 'test-env',
      githubToken: 'read-only-is-enough', githubOwner: 'owner', githubRepo: 'repo'
    }
  });
  t.after(() => server.close());
  const response = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' },
    body: JSON.stringify({ method: 'save_powerapps_app', params: {} })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /保存停止/);
  assert.deepEqual(actions, []);
});

test('編集は隔離ブランチのGitHubだけに記録し本番同期と公開を呼ばない', async (t) => {
  const requests = [];
  const mockFetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url, method, body: options.body });
    if (url.includes('/contents/')) {
      if (method === 'GET') return new Response(JSON.stringify({
        type: 'file', sha: 'previous-sha',
        content: Buffer.from('before', 'utf8').toString('base64')
      }), { status: 200 });
      if (method === 'PUT') return new Response(JSON.stringify({
        commit: { sha: 'staged-commit' }, content: { sha: 'new-content' }
      }), { status: 200 });
    }
    throw new Error('Unexpected upstream call: ' + url);
  };
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    fetchImpl: mockFetch,
    powerAppsOverrides: {
      sourceAppId: 'test-app', sourceEnvironmentId: 'test-env',
      githubToken: 'test-token', githubOwner: 'owner', githubRepo: 'repo',
      githubBranch: 'work/cn-aiiraidaicho-stage-20260927',
      githubRoot: 'powerapps/CN_AI依頼台帳/Source'
    }
  });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' };
  const response = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({
      method: 'update_powerapps_app',
      params: { relativePath: 'S9_UserConfirm.pa.yaml', content: 'after', message: 'stage test' }
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.status, 'staged');
  assert.equal(body.result.productionChanged, false);
  assert.equal(body.result.commitSha, 'staged-commit');
  assert.equal(requests.filter(r => r.method === 'PUT').length, 1);
  assert.ok(requests.every(r => r.url.startsWith('https://api.github.com/')));
  assert.ok(JSON.parse(requests.find(r => r.method === 'PUT').body).branch === 'work/cn-aiiraidaicho-stage-20260927');
  const publish = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ method: 'publish_powerapps_app', params: {} })
  });
  assert.equal(publish.status, 400);
  assert.match((await publish.json()).error, /公開停止/);
  assert.equal(requests.length, 2);
});

test('隔離ブランチ以外へのソース更新をGitHub書き込み前に拒否する', async (t) => {
  const calls = [];
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET' });
      throw new Error('upstream must not be called');
    },
    powerAppsOverrides: {
      sourceAppId: 'test-app', sourceEnvironmentId: 'test-env',
      githubToken: 'test-token', githubOwner: 'owner', githubRepo: 'repo',
      githubBranch: 'main',
      githubRoot: 'powerapps/CN_AI依頼台帳/Source'
    }
  });
  t.after(() => server.close());
  const response = await fetch(`${server.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' },
    body: JSON.stringify({
      method: 'update_powerapps_app',
      params: { relativePath: 'App.pa.yaml', content: 'after' }
    })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /隔離済み17ファイルのブランチ/);
  assert.deepEqual(calls, []);
});

test('ソースと操作対象が不一致なら更新・保存・公開は書き込み前に止まる', async (t) => {
  const calls = [];
  const server = await createTestServer([seedTask], {
    mcpApiKey: 'mcp-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET' });
      throw new Error('upstream must not be called');
    },
    powerAppsOverrides: {
      sourceAppId: 'different-app', sourceEnvironmentId: 'different-env'
    }
  });
  t.after(() => server.close());
  for (const [method, params] of [
    ['update_powerapps_app', { relativePath: 'App.pa.yaml', content: 'changed' }],
    ['save_powerapps_app', {}],
    ['publish_powerapps_app', {}]
  ]) {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'mcp-secret' },
      body: JSON.stringify({ method, params })
    });
    assert.equal(response.status, 409, method);
    const body = await response.json();
    assert.match(body.error, /ソース対象と操作対象/);
  }
  assert.deepEqual(calls, []);
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

  const response = await fetch(`${server.baseUrl}/mcp/tools/list`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tools.map((tool) => tool.name), [
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
  assert.equal(listedBody.result.tools.length, 16);
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
