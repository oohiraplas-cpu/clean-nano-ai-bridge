const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, MCP_METHODS, MCP_PUBLIC_TOOLS, PUBLISHED_TOOLS } = require('../src/server');
const { getConfig } = require('../src/config');
const { containsLikelySecret } = require('../src/secretMasking');
const windowsJobs = require('../src/windowsJobs');

const KEY = 'test-master-key-9f3a1c77';

async function startServer(env = { MCP_API_KEY: KEY }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-jobs-'));
  const config = getConfig({ WEBHOOK_API_KEY: 'hook-key-1234', TASKS_FILE: path.join(dir, 'tasks.json'), ...env });
  const server = createApp(config).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const call = (base, method, route, body, headers = auth) => fetch(`${base}${route}`, {
  method,
  headers,
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const uid = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ---------- existing surface is preserved ----------

test('the 24 published tools and the existing MCP surface are preserved', () => {
  assert.equal(PUBLISHED_TOOLS.length, 24);
  const published = PUBLISHED_TOOLS.map((tool) => tool.name);
  for (const name of ['system_health', 'canvas_resolve', 'canvas_read', 'canvas_media', 'canvas_edit', 'canvas_save', 'canvas_verify', 'canvas_publish',
    'canvas_rollback', 'audit_get', 'sharepoint', 'power_automate', 'tasks', 'github_azure', 'governance', 'runtime_capture', 'deployment', 'user_access',
    'employee_ledger', 'health_check', 'resolve_app_target', 'get_powerapps_app', 'get_powerapps_state', 'get_powerapps_source']) {
    assert.ok(published.includes(name), `published tool missing: ${name}`);
  }
  assert.ok(MCP_METHODS.length >= 100, `MCP_METHODS shrank: ${MCP_METHODS.length}`);
  for (const name of ['get_powerapps_state', 'save_powerapps_app', 'run_power_automate_flow', 'get_agent_registry', 'create_employee_ledger_entry']) {
    assert.ok(MCP_METHODS.includes(name), name);
  }
});

test('cnai_submit_windows_job exists as an MCP method and tool definition, but is not a connector read-only tool', () => {
  assert.ok(MCP_METHODS.includes('cnai_submit_windows_job'));
  const tool = MCP_PUBLIC_TOOLS.find((item) => item.name === 'cnai_submit_windows_job');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['action', 'workspace', 'riskLevel']);
  assert.deepEqual(tool.inputSchema.properties.riskLevel.enum, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
});

// ---------- authentication ----------

test('all executor/job routes and /mcp reject unauthenticated calls with 401 (never 404)', async () => {
  const { base, close } = await startServer();
  try {
    const checks = [
      ['POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      ['POST', '/executor/register', { executorId: 'CN-WIN-01' }],
      ['POST', '/executor/heartbeat', { executorId: 'CN-WIN-01' }],
      ['POST', '/job/submit', { action: 'bridge_read_verify', workspace: '.', riskLevel: 'LOW' }],
      ['GET', '/job/pull?executorId=CN-WIN-01'],
      ['POST', '/job/checkpoint', { taskId: 'x' }],
      ['POST', '/job/result', { taskId: 'x' }],
      ['GET', '/job/some-task']
    ];
    for (const [method, route, body] of checks) {
      const res = await call(base, method, route, body, { 'content-type': 'application/json' });
      assert.equal(res.status, 401, `${method} ${route}`);
      const wrong = await call(base, method, route, body, { authorization: 'Bearer wrong-key', 'content-type': 'application/json' });
      assert.equal(wrong.status, 401, `${method} ${route} (wrong key)`);
    }
  } finally { await close(); }
});

test('job routes fail closed (503) when no MCP_API_KEY is configured', async () => {
  const { base, close } = await startServer({});
  try {
    for (const [method, route, body] of [['POST', '/executor/register', { executorId: 'CN-WIN-01' }], ['GET', '/job/pull?executorId=CN-WIN-01'], ['POST', '/job/submit', {}]]) {
      const res = await call(base, method, route, body, { 'content-type': 'application/json' });
      assert.equal(res.status, 503, `${method} ${route}`);
    }
  } finally { await close(); }
});

// ---------- end-to-end over HTTP: submit -> pull -> checkpoint -> result ----------

test('E2E: register -> heartbeat -> submit -> pull -> checkpoint -> result (COMPLETED)', async () => {
  const { base, close } = await startServer();
  const executorId = uid('E2E-EXEC');
  const taskId = uid('e2e-task');
  try {
    let res = await call(base, 'POST', '/executor/register', { executorId, version: '1.0.0', capabilities: ['git', 'node'] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'REGISTERED');

    res = await call(base, 'POST', '/executor/heartbeat', { executorId, status: 'IDLE', currentTask: null });
    assert.equal(res.status, 200);
    const hb = await res.json();
    assert.equal(hb.status, 'OK');
    assert.equal(hb.reRegistered, false);

    res = await call(base, 'POST', '/job/submit', { taskId, action: 'bridge_read_verify', workspace: '.', riskLevel: 'LOW' });
    assert.equal(res.status, 200);
    const submitted = await res.json();
    assert.equal(submitted.accepted, true);
    assert.equal(submitted.status, 'QUEUED');

    res = await call(base, 'GET', `/job/pull?executorId=${executorId}`);
    assert.equal(res.status, 200);
    const pulled = await res.json();
    assert.equal(pulled.accepted, true);
    assert.equal(pulled.job.taskId, taskId);
    assert.equal(pulled.job.action, 'bridge_read_verify');
    assert.equal(pulled.job.status, 'RUNNING');

    res = await call(base, 'POST', '/job/checkpoint', { taskId, status: 'PREFLIGHT', completedSteps: [], nextStep: 'bridge_read_verify', changedFiles: [], testStatus: 'PENDING' });
    assert.equal(res.status, 200);
    const cp = await res.json();
    assert.equal(cp.accepted, true);
    assert.equal(cp.checkpoint.stage, 'PREFLIGHT');
    assert.equal(cp.status, 'RUNNING');

    res = await call(base, 'POST', '/job/result', { taskId, executorId, status: 'COMPLETED', evidence: { toolCount: 24, health: { status: 'ok' } } });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.result.status, 'COMPLETED');

    res = await call(base, 'GET', `/job/${taskId}`);
    const final = await res.json();
    assert.equal(final.job.status, 'COMPLETED');
    assert.equal(final.job.result.status, 'COMPLETED');
    assert.equal(final.job.checkpointHistory.length, 1);

    // nothing left to pull
    res = await call(base, 'GET', `/job/pull?executorId=${executorId}`);
    assert.equal((await res.json()).job, null);
  } finally { await close(); }
});

test('E2E via MCP: tools/call cnai_submit_windows_job queues a job that the executor pulls', async () => {
  const { base, close } = await startServer();
  const executorId = uid('MCP-EXEC');
  const taskId = uid('mcp-task');
  try {
    await call(base, 'POST', '/executor/register', { executorId });
    const res = await call(base, 'POST', '/mcp', {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'cnai_submit_windows_job', arguments: { taskId, action: 'bridge_read_verify', workspace: '.', riskLevel: 'LOW' } }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.isError, false);
    assert.equal(body.result.structuredContent.accepted, true);
    assert.equal(body.result.structuredContent.status, 'QUEUED');
    const pull = await (await call(base, 'GET', `/job/pull?executorId=${executorId}`)).json();
    assert.equal(pull.job.taskId, taskId);
  } finally { await close(); }
});

test('MCP tool validates input (missing action / bad risk level -> isError, nothing queued)', async () => {
  const { base, close } = await startServer();
  try {
    for (const args of [{ workspace: '.', riskLevel: 'LOW' }, { action: 'bridge_read_verify', riskLevel: 'LOW' }, { action: 'bridge_read_verify', workspace: '.', riskLevel: 'EXTREME' }]) {
      const res = await call(base, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cnai_submit_windows_job', arguments: args } });
      const body = await res.json();
      assert.equal(body.result.isError, true, JSON.stringify(args));
    }
  } finally { await close(); }
});

// ---------- risk gating and duplicate prevention ----------

test('HIGH and CRITICAL jobs wait for approval and are never handed to an executor', async () => {
  const { base, close } = await startServer();
  const executorId = uid('RISK-EXEC');
  try {
    await call(base, 'POST', '/executor/register', { executorId });
    for (const riskLevel of ['HIGH', 'CRITICAL']) {
      const taskId = uid(`risk-${riskLevel.toLowerCase()}`);
      const submitted = await (await call(base, 'POST', '/job/submit', { taskId, action: 'build', workspace: '.', riskLevel })).json();
      assert.equal(submitted.accepted, true);
      assert.equal(submitted.status, 'WAITING_FOR_APPROVAL');
    }
    const pull = await (await call(base, 'GET', `/job/pull?executorId=${executorId}`)).json();
    assert.equal(pull.job, null);
  } finally { await close(); }
});

test('MEDIUM jobs are accepted automatically', async () => {
  const state = windowsJobs.createWindowsJobState();
  const result = windowsJobs.submitWindowsJob(state, { taskId: 'm1', action: 'test', workspace: '.', riskLevel: 'medium' });
  assert.equal(result.status, 'QUEUED');
  assert.equal(windowsJobs.pullWindowsJob(state, 'EX-1').job.taskId, 'm1');
});

test('a duplicate taskId is not accepted twice and is never executed twice', async () => {
  const { base, close } = await startServer();
  const executorId = uid('DUP-EXEC');
  const taskId = uid('dup-task');
  try {
    await call(base, 'POST', '/executor/register', { executorId });
    const first = await (await call(base, 'POST', '/job/submit', { taskId, action: 'bridge_read_verify', workspace: '.', riskLevel: 'LOW' })).json();
    assert.equal(first.accepted, true);
    const second = await (await call(base, 'POST', '/job/submit', { taskId, action: 'bridge_read_verify', workspace: '.', riskLevel: 'LOW' })).json();
    assert.equal(second.accepted, false);
    assert.equal(second.duplicate, true);
    assert.equal((await (await call(base, 'GET', `/job/pull?executorId=${executorId}`)).json()).job.taskId, taskId);
    assert.equal((await (await call(base, 'GET', `/job/pull?executorId=${executorId}`)).json()).job, null);
    // a submit after completion still must not re-run the job
    await call(base, 'POST', '/job/result', { taskId, executorId, status: 'COMPLETED' });
    const third = await (await call(base, 'POST', '/job/submit', { taskId, action: 'bridge_read_verify', workspace: '.', riskLevel: 'LOW' })).json();
    assert.equal(third.accepted, false);
    assert.equal(third.status, 'COMPLETED');
    assert.equal((await (await call(base, 'GET', `/job/pull?executorId=${executorId}`)).json()).job, null);
  } finally { await close(); }
});

test('two executors never receive the same job', () => {
  const state = windowsJobs.createWindowsJobState();
  windowsJobs.submitWindowsJob(state, { taskId: 'one', action: 'a', workspace: '.', riskLevel: 'LOW' });
  const a = windowsJobs.pullWindowsJob(state, 'EX-A');
  const b = windowsJobs.pullWindowsJob(state, 'EX-B');
  assert.equal(a.job.taskId, 'one');
  assert.equal(b.job, null);
});

// ---------- resilience: re-registration, auto resume, terminal states ----------

test('heartbeat and pull from an unknown executor register it implicitly (Bridge restart recovery)', () => {
  const state = windowsJobs.createWindowsJobState();
  const hb = windowsJobs.heartbeatExecutor(state, { executorId: 'CN-WIN-01', status: 'idle' });
  assert.equal(hb.reRegistered, true);
  assert.equal(state.executors.get('CN-WIN-01').status, 'IDLE');
  const second = windowsJobs.heartbeatExecutor(state, { executorId: 'CN-WIN-01', status: 'running', currentTask: 't' });
  assert.equal(second.reRegistered, false);
  assert.equal(state.executors.get('CN-WIN-01').status, 'RUNNING');
  const pulled = windowsJobs.pullWindowsJob(state, 'CN-WIN-02');
  assert.equal(pulled.job, null);
  assert.ok(state.executors.has('CN-WIN-02'));
});

test('Auto Resume: a restarted executor gets its interrupted job back with the checkpoint kept, and it completes exactly once', () => {
  const state = windowsJobs.createWindowsJobState();
  windowsJobs.registerExecutor(state, { executorId: 'CN-WIN-01' });
  windowsJobs.submitWindowsJob(state, { taskId: 'resume-1', action: 'build', workspace: '.', riskLevel: 'LOW' });
  assert.equal(windowsJobs.pullWindowsJob(state, 'CN-WIN-01').status, 'assigned');
  windowsJobs.checkpointWindowsJob(state, { taskId: 'resume-1', status: 'BUILD_DONE', completedSteps: ['install'], nextStep: 'test', resumeToken: 'resume-token-1' });

  // the executor process dies and starts again
  const reg = windowsJobs.registerExecutor(state, { executorId: 'CN-WIN-01' });
  assert.deepEqual(reg.resumedTasks, ['resume-1']);
  const resumed = windowsJobs.pullWindowsJob(state, 'CN-WIN-01');
  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.job.taskId, 'resume-1');
  assert.equal(resumed.job.lastCheckpoint.nextStep, 'test');
  assert.equal(resumed.job.resumeToken, 'resume-token-1');
  assert.equal(resumed.job.checkpointHistory.length, 1);

  const done = windowsJobs.resultWindowsJob(state, { taskId: 'resume-1', executorId: 'CN-WIN-01', status: 'COMPLETED' });
  assert.equal(done.status, 'COMPLETED');
  assert.throws(() => windowsJobs.resultWindowsJob(state, { taskId: 'resume-1', status: 'COMPLETED' }), (error) => error.status === 409);
  assert.equal(windowsJobs.pullWindowsJob(state, 'CN-WIN-01').job, null);
});

test('checkpoint/result are refused for unknown, queued and finished jobs', () => {
  const state = windowsJobs.createWindowsJobState();
  assert.throws(() => windowsJobs.checkpointWindowsJob(state, { taskId: 'nope' }), (error) => error.status === 404);
  assert.throws(() => windowsJobs.resultWindowsJob(state, { taskId: 'nope' }), (error) => error.status === 404);
  windowsJobs.submitWindowsJob(state, { taskId: 'q1', action: 'a', workspace: '.', riskLevel: 'LOW' });
  assert.throws(() => windowsJobs.resultWindowsJob(state, { taskId: 'q1' }), (error) => error.status === 409);
  windowsJobs.pullWindowsJob(state, 'EX');
  windowsJobs.resultWindowsJob(state, { taskId: 'q1', status: 'BLOCKED', reason: 'Unsupported action' });
  assert.equal(state.jobs.get('q1').status, 'BLOCKED');
  assert.throws(() => windowsJobs.checkpointWindowsJob(state, { taskId: 'q1' }), (error) => error.status === 409);
  assert.throws(() => windowsJobs.resultWindowsJob(state, { taskId: 'q1', status: 'WEIRD' }), (error) => error.status === 409 || error.status === 400);
});

test('input validation: ids, lengths, missing fields', () => {
  const state = windowsJobs.createWindowsJobState();
  const bad = (params) => assert.throws(() => windowsJobs.submitWindowsJob(state, params), (error) => error.status === 400, JSON.stringify(params).slice(0, 80));
  bad({ action: 'a', workspace: '.', riskLevel: 'LOW', taskId: '../etc/passwd' });
  bad({ action: '', workspace: '.', riskLevel: 'LOW' });
  bad({ action: 'a', workspace: '', riskLevel: 'LOW' });
  bad({ action: 'a', workspace: '.', riskLevel: 'nope' });
  bad({ action: 'x'.repeat(1001), workspace: '.', riskLevel: 'LOW' });
  assert.throws(() => windowsJobs.registerExecutor(state, {}), (error) => error.status === 400);
  assert.throws(() => windowsJobs.registerExecutor(state, { executorId: 'bad id!' }), (error) => error.status === 400);
  assert.equal(state.jobs.size, 0);
});

// ---------- secret hygiene ----------

test('secrets in job text, checkpoints and results are masked and the API key is never echoed', async () => {
  const { base, close } = await startServer();
  const executorId = uid('SEC-EXEC');
  const taskId = uid('sec-task');
  const leaked = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  try {
    await call(base, 'POST', '/executor/register', { executorId });
    const submitted = await call(base, 'POST', '/job/submit', { taskId, action: `deploy with Authorization: Bearer ${leaked}`, workspace: '.', riskLevel: 'LOW' });
    assert.ok(!(await submitted.text()).includes(leaked));
    const pulled = await (await call(base, 'GET', `/job/pull?executorId=${executorId}`)).json();
    assert.ok(!JSON.stringify(pulled).includes(leaked));
    await call(base, 'POST', '/job/checkpoint', { taskId, status: 'X', nextStep: `use token ${leaked}` });
    const done = await call(base, 'POST', '/job/result', { taskId, executorId, status: 'COMPLETED', output: `token=${leaked}`, evidence: { apiKey: 'plain-secret-value', note: `Bearer ${leaked}` } });
    const text = await done.text();
    assert.ok(!text.includes(leaked));
    assert.ok(!text.includes('plain-secret-value'));
    const job = await (await call(base, 'GET', `/job/${taskId}`)).text();
    assert.ok(!job.includes(leaked));
    assert.ok(!job.includes(KEY));
  } finally { await close(); }
});

test('a resumeToken that looks like a credential is refused instead of being stored', () => {
  const state = windowsJobs.createWindowsJobState();
  windowsJobs.submitWindowsJob(state, { taskId: 'rt1', action: 'a', workspace: '.', riskLevel: 'LOW' });
  windowsJobs.pullWindowsJob(state, 'EX');
  assert.throws(() => windowsJobs.checkpointWindowsJob(state, { taskId: 'rt1', resumeToken: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }), (error) => error.status === 400);
  assert.throws(() => windowsJobs.checkpointWindowsJob(state, { taskId: 'rt1', resumeToken: 'has space' }), (error) => error.status === 400);
  assert.equal(state.jobs.get('rt1').checkpointHistory.length, 0);
});

test('the job module contains no hard-coded secret', () => {
  const source = fsSync.readFileSync(path.join(__dirname, '..', 'src', 'windowsJobs.js'), 'utf8');
  assert.equal(containsLikelySecret(source), false);
  assert.ok(!/MCP_API_KEY\s*=\s*['"][^'"]+['"]/.test(source));
});
