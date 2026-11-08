'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const cnaiRouter = require('../src/cnaiRouter');
const windowsJobs = require('../src/windowsJobs');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');

const KEY = 'test-router-key-9f3a1c77';

async function startServer(env = { MCP_API_KEY: KEY }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnai-router-'));
  const config = getConfig({ WEBHOOK_API_KEY: 'hook-key-1234', TASKS_FILE: path.join(dir, 'tasks.json'), ...env });
  const server = createApp(config).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const call = (base, method, route, body, headers = auth) => fetch(`${base}${route}`, {
  method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

function freshState() {
  return cnaiRouter.createRouterState();
}

// ---------- normal path: route selection ----------

test('classify: known platformHint maps to its route', () => {
  assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: 'sharepoint' }).route, 'sharepoint');
  assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: 'm365' }).route, 'microsoft365');
  assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: 'powerapps' }).route, 'powerPlatformStandard');
  assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: 'mcp' }).route, 'operationsMcp');
  assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: 'windows' }).route, 'windowsExecutor');
  assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: 'code' }).route, 'localCode');
  assert.equal(cnaiRouter.classify({ requestType: 'q', platformHint: 'chatgpt' }).route, 'externalAiReference');
});

test('classify: unknown platformHint and no explicit route is refused, never guessed', () => {
  assert.throws(() => cnaiRouter.classify({ requestType: 'q', platformHint: 'unknown-thing' }), (e) => e.status === 400);
  assert.throws(() => cnaiRouter.classify({ requestType: 'q' }), (e) => e.status === 400);
  assert.throws(() => cnaiRouter.classify({ platformHint: 'sharepoint' }), (e) => e.status === 400);
});

test('localCode route completes and is VERIFIED (deterministic, no external call)', async () => {
  const state = freshState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'run local check', platformHint: 'code', payload: { x: 1 } });
  assert.equal(result.selectedRoute, 'localCode');
  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.verificationStatus, 'VERIFIED');
  assert.ok(result.completedAt);
  assert.ok(result.checkpointId);
});

test('windowsExecutor route (LOW risk) is queued but not claimed COMPLETED until the job actually finishes', async () => {
  const state = freshState();
  const jobState = windowsJobs.createWindowsJobState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'bridge_read_verify', platformHint: 'windows', riskLevel: 'LOW', workspace: '.' },
    cnaiRouter.defaultAdapters({ jobState }));
  assert.equal(result.selectedRoute, 'windowsExecutor');
  assert.equal(result.executionStatus, 'PARTIAL');
  assert.equal(result.verificationStatus, 'UNVERIFIED');
  assert.equal(jobState.jobs.get(result.requestId).status, 'QUEUED');
});

test('windowsExecutor route (HIGH risk) is BLOCKED and never handed to an executor', async () => {
  const state = freshState();
  const jobState = windowsJobs.createWindowsJobState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'deploy', platformHint: 'windows', riskLevel: 'HIGH', workspace: '.' },
    cnaiRouter.defaultAdapters({ jobState }));
  assert.equal(result.executionStatus, 'BLOCKED');
  assert.equal(result.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(windowsJobs.pullWindowsJob(jobState, 'EX').job, null);
});

test('operationsMcp / sharepoint route with an injected adapter completes normally', async () => {
  const state = freshState();
  const adapters = cnaiRouter.defaultAdapters({ adapters: {
    operationsMcp: async () => ({ success: true, verified: true, tools: 25 }),
    sharepoint: async () => ({ success: true, verified: true, listId: 'abc' })
  } });
  const mcpResult = await cnaiRouter.routeRequest(state, { requestType: 'tools/list', platformHint: 'mcp' }, adapters);
  assert.equal(mcpResult.executionStatus, 'COMPLETED');
  const spResult = await cnaiRouter.routeRequest(state, { requestType: 'list items', platformHint: 'sharepoint' }, adapters);
  assert.equal(spResult.executionStatus, 'COMPLETED');
});

test('a route with no adapter configured BLOCKS (never fabricates success)', async () => {
  const state = freshState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'send mail', platformHint: 'm365' }, cnaiRouter.defaultAdapters());
  assert.equal(result.executionStatus, 'BLOCKED');
  assert.equal(result.errorCode, 'ADAPTER_NOT_CONFIGURED');
});

test('audit trail starts with RECEIVED and records every state transition; checkpoint history matches', async () => {
  const state = freshState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'code' });
  const audit = cnaiRouter.getAuditTrail(state, result.requestId);
  assert.equal(audit.trail[0].event, 'RECEIVED');
  assert.ok(audit.trail.some((e) => e.event === 'COMPLETED'));
  const checkpoint = cnaiRouter.getCheckpoint(state, result.requestId);
  assert.equal(checkpoint.checkpointId, result.checkpointId);
  assert.ok(checkpoint.history.length >= audit.trail.length - 1);
});

// ---------- abnormal paths ----------

test('duplicate idempotencyKey is never re-dispatched', async () => {
  const state = freshState();
  const first = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'code', idempotencyKey: 'dup-1' });
  const second = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'code', idempotencyKey: 'dup-1' });
  assert.equal(second.duplicate, true);
  assert.equal(second.requestId, first.requestId);
});

test('a Premium/paid route with no free alternative BLOCKS only that task', async () => {
  const state = freshState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'premium feature', route: 'blockedPaidRoute' });
  assert.equal(result.executionStatus, 'BLOCKED');
  assert.equal(result.errorCode, 'PAID_ROUTE_BLOCKED');
  assert.equal(result.costClass, 'PAID');
});

test('a paid/unreachable route falls back to a free alternative when one is known', async () => {
  const state = freshState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'premium feature', route: 'blockedPaidRoute', requiredCapability: 'code_task' });
  assert.equal(result.selectedRoute, 'localCode');
  assert.equal(result.fallbackRoute, 'localCode');
  assert.equal(result.costClass, 'FREE');
  assert.equal(result.executionStatus, 'COMPLETED');
});

test('external AI is never reported as executed from this session when unavailable', async () => {
  const state = freshState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'ask', platformHint: 'chatgpt' });
  assert.equal(result.executionStatus, 'BLOCKED');
  assert.equal(result.errorCode, 'EXTERNAL_AI_UNAVAILABLE');
  assert.equal(result.verificationStatus, 'UNVERIFIED');
});

test('an adapter error (simulated timeout/exception) fails the request without crashing the router', async () => {
  const state = freshState();
  const adapters = cnaiRouter.defaultAdapters({ adapters: { sharepoint: async () => { throw new Error('upstream timeout'); } } });
  const result = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'sharepoint' }, adapters);
  assert.equal(result.executionStatus, 'FAILED');
  assert.equal(result.errorCode, 'ADAPTER_ERROR');
});

test('a success without verified:true is PARTIAL, never COMPLETED (unconfirmed results are not PASSed)', async () => {
  const state = freshState();
  const adapters = cnaiRouter.defaultAdapters({ adapters: { sharepoint: async () => ({ success: true }) } });
  const result = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'sharepoint' }, adapters);
  assert.equal(result.executionStatus, 'PARTIAL');
  assert.equal(result.verificationStatus, 'UNVERIFIED');
});

test('resume: a FAILED request can be resumed and succeeds once the adapter is fixed', async () => {
  const state = freshState();
  let shouldFail = true;
  const adapters = cnaiRouter.defaultAdapters({ adapters: { sharepoint: async () => {
    if (shouldFail) throw new Error('temporary failure');
    return { success: true, verified: true };
  } } });
  const first = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'sharepoint' }, adapters);
  assert.equal(first.executionStatus, 'FAILED');
  shouldFail = false;
  const resumed = await cnaiRouter.resumeRequest(state, first.requestId, {}, adapters);
  assert.equal(resumed.executionStatus, 'COMPLETED');
});

test('resume refuses requests that are not FAILED/BLOCKED', async () => {
  const state = freshState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'code' });
  await assert.rejects(() => cnaiRouter.resumeRequest(state, result.requestId, {}), (e) => e.status === 400);
});

test('rollback is state-only and discloses that scope; rolling back twice is idempotent', async () => {
  const state = freshState();
  const result = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'code' });
  const rolled = cnaiRouter.rollbackRequest(state, result.requestId, 'user requested');
  assert.equal(rolled.executionStatus, 'ROLLED_BACK');
  assert.equal(rolled.rollbackScope, 'state_only');
  const again = cnaiRouter.rollbackRequest(state, result.requestId, 'ignored');
  assert.equal(again.executionStatus, 'ROLLED_BACK');
});

test('secrets in payload, errors and checkpoints are masked everywhere they are exposed', async () => {
  const state = freshState();
  const leaked = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const adapters = cnaiRouter.defaultAdapters({ adapters: { sharepoint: async () => { throw new Error(`failed with Authorization: Bearer ${leaked}`); } } });
  const result = await cnaiRouter.routeRequest(state, { requestType: 'x', platformHint: 'sharepoint', payload: { apiKey: 'plain-secret-value' } }, adapters);
  const asText = JSON.stringify(result);
  assert.ok(!asText.includes(leaked));
  assert.ok(!asText.includes('plain-secret-value'));
  const audit = cnaiRouter.getAuditTrail(state, result.requestId);
  assert.ok(!JSON.stringify(audit).includes(leaked));
  assert.ok(!JSON.stringify(audit).includes('plain-secret-value'));
});

test('getStatus/getCheckpoint/getAuditTrail for an unknown requestId is a 404, not a crash', () => {
  const state = freshState();
  assert.throws(() => cnaiRouter.getStatus(state, 'nope'), (e) => e.status === 404);
  assert.throws(() => cnaiRouter.getCheckpoint(state, 'nope'), (e) => e.status === 404);
  assert.throws(() => cnaiRouter.getAuditTrail(state, 'nope'), (e) => e.status === 404);
});

// ---------- HTTP + MCP integration ----------

test('router routes reject unauthenticated calls with 401, and fail-closed 503 with no key configured', async () => {
  const { base, close } = await startServer();
  try {
    const res = await call(base, 'POST', '/router/request', { requestType: 'x', platformHint: 'code' }, { 'content-type': 'application/json' });
    assert.equal(res.status, 401);
  } finally { await close(); }

  const noKey = await startServer({});
  try {
    const res = await call(noKey.base, 'POST', '/router/request', { requestType: 'x', platformHint: 'code' }, { 'content-type': 'application/json' });
    assert.equal(res.status, 503);
  } finally { await noKey.close(); }
});

test('E2E over HTTP: /router/request runs localCode to completion and /router/request/:id reports it back', async () => {
  const { base, close } = await startServer();
  try {
    const submitted = await (await call(base, 'POST', '/router/request', { requestType: 'local check', platformHint: 'code' })).json();
    assert.equal(submitted.executionStatus, 'COMPLETED');
    const fetched = await (await call(base, 'GET', `/router/request/${submitted.requestId}`)).json();
    assert.equal(fetched.status.requestId, submitted.requestId);
    assert.ok(fetched.audit.trail.length > 0);
    assert.ok(fetched.checkpoint.history.length > 0);
  } finally { await close(); }
});

test('E2E via MCP: tools/call cnai_route_request / cnai_get_route_status / cnai_rollback_route', async () => {
  const { base, close } = await startServer();
  try {
    const res = await call(base, 'POST', '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cnai_route_request', arguments: { requestType: 'local check', platformHint: 'code' } }
    });
    const body = await res.json();
    assert.equal(body.result.isError, false);
    assert.equal(body.result.structuredContent.executionStatus, 'COMPLETED');
    const requestId = body.result.structuredContent.requestId;

    const statusRes = await call(base, 'POST', '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'cnai_get_route_status', arguments: { requestId } }
    });
    const statusBody = await statusRes.json();
    assert.equal(statusBody.result.structuredContent.status.requestId, requestId);

    const rollbackRes = await call(base, 'POST', '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'cnai_rollback_route', arguments: { requestId, reason: 'test rollback' } }
    });
    const rollbackBody = await rollbackRes.json();
    assert.equal(rollbackBody.result.structuredContent.executionStatus, 'ROLLED_BACK');
  } finally { await close(); }
});

test('MCP tool rejects malformed params instead of crashing', async () => {
  const { base, close } = await startServer();
  try {
    const res = await call(base, 'POST', '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cnai_route_request', arguments: 'not-an-object' }
    });
    const body = await res.json();
    assert.equal(body.result.isError, true);
  } finally { await close(); }
});
