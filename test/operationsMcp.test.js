'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createOperationsMcp, TOOL_DEFS, APPROVAL_REQUIRED_TYPES, FORBIDDEN_OPERATION_TYPES } = require('../src/operationsMcp');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');

const EXPECTED_TOOLS = [
  'health_check', 'version_get', 'tools_list', 'tool_schema_get', 'capability_check', 'authentication_check',
  'permission_check', 'license_check', 'connection_test', 'environment_get', 'operation_plan',
  'operation_status', 'operation_cancel', 'dry_run', 'snapshot_create', 'operation_verify', 'audit_write',
  'rollback_execute'
];
const IMPLEMENTED = ['health_check', 'version_get', 'tools_list', 'tool_schema_get', 'capability_check',
  'authentication_check', 'environment_get', 'operation_plan', 'operation_status', 'operation_cancel', 'dry_run'];

const planArgs = (overrides = {}) => ({
  operationType: 'read',
  targetEnvironmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
  targetObjectId: 'obj-1',
  action: '状態を読む',
  ...overrides
});

test('the catalogue contains the 18 common tools from the operations contract', () => {
  const names = TOOL_DEFS.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
});

test('every tool carries the contract metadata with valid enum values', () => {
  for (const tool of TOOL_DEFS) {
    assert.ok(['READ', 'WRITE', 'VERIFY', 'RELEASE', 'PERMISSION', 'DELETE', 'BILLING', 'ROLLBACK'].includes(tool.category), tool.name);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(tool.riskLevel), tool.name);
    assert.equal(tool.additionalCost, false, tool.name);
    assert.equal(tool.auditRequired, tool.category !== 'READ', tool.name);
    assert.equal(typeof tool.requiresApproval, 'boolean', tool.name);
  }
});

test('approval and forbidden operation sets do not overlap', () => {
  for (const type of FORBIDDEN_OPERATION_TYPES) assert.equal(APPROVAL_REQUIRED_TYPES.includes(type), false, type);
});

test('tools/list over the handler returns the catalogue with input schemas', () => {
  const mcp = createOperationsMcp({});
  const res = mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(res.result.tools.length, EXPECTED_TOOLS.length);
  assert.ok(res.result.tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'));
});

test('version_get reports the package version and the configured deployment SHA', () => {
  const mcp = createOperationsMcp({ deploymentSha: 'abc123' });
  const payload = mcp.callTool('version_get');
  assert.equal(payload.status, 'PASS');
  assert.equal(payload.internalName, 'clean-nano-operations');
  assert.equal(payload.deploymentSha, 'abc123');
});

test('capability_check reports partial status and marks every unimplemented tool as blocked', () => {
  const payload = createOperationsMcp({}).callTool('capability_check');
  assert.equal(payload.status, 'PARTIAL');
  assert.equal(payload.implemented, IMPLEMENTED.length);
  assert.equal(payload.blocked, EXPECTED_TOOLS.length - IMPLEMENTED.length);
  for (const tool of payload.tools) {
    const expected = IMPLEMENTED.includes(tool.name) ? 'implemented' : 'blocked';
    assert.equal(tool.implementationStatus, expected, tool.name);
  }
});

test('authentication_check reports presence only and never returns secret values', () => {
  const secret = 'SECRET-VALUE-DO-NOT-LEAK-12345';
  const mcp = createOperationsMcp({ mcpApiKey: secret, connectorApiKey: '' });
  const payload = mcp.callTool('authentication_check');
  assert.equal(payload.mcpApiKeyConfigured, true);
  assert.equal(payload.connectorApiKeyConfigured, false);
  assert.equal(JSON.stringify(payload).includes(secret), false);
});

test('authentication_check fails closed when the MCP key is not configured', () => {
  const payload = createOperationsMcp({ mcpApiKey: '' }).callTool('authentication_check');
  assert.equal(payload.status, 'FAIL');
  assert.equal(payload.mcpApiKeyConfigured, false);
});

test('environment_get returns the confirmed profile values without any secret field', () => {
  const payload = createOperationsMcp({}).callTool('environment_get');
  assert.equal(payload.profile.environmentId, '4d0aab59-43ec-ecf1-a9d1-869f2517adbb');
  assert.equal(payload.profile.solutionName, 'CN_CompanyOS_Core');
  assert.equal(payload.profile.sharePointSiteUrl, 'https://hisyoengineer.sharepoint.com/sites/cleannano');
  assert.equal(payload.profile.currentAppServiceEnvName, 'CN_MCP_API_KEY');
  // 値ではなくキー名で判定する（認証形式の表記 "<token>" はプレースホルダであり秘密値ではない）
  assert.equal(Object.keys(payload.profile).some((key) => /secret|password|token/i.test(key)), false);
});

test('external-dependent tools return BLOCKED and never PASS', () => {
  const mcp = createOperationsMcp({});
  for (const name of ['permission_check', 'license_check', 'connection_test', 'snapshot_create',
    'operation_verify', 'audit_write', 'rollback_execute']) {
    const payload = mcp.callTool(name);
    assert.equal(payload.status, 'BLOCKED', name);
    assert.equal(payload.executed, false, name);
    assert.ok(payload.reasonCode, name);
    assert.ok(payload.nextStep, name);
  }
});

test('a read operation plan is planned, can be dry-run, and is never executed', () => {
  const mcp = createOperationsMcp({});
  const plan = mcp.callTool('operation_plan', planArgs());
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.operationStatus, 'planned');
  assert.equal(plan.approvalRequired, false);
  assert.equal(plan.executed, false);
  assert.match(plan.planHash, /^[0-9a-f]{64}$/);

  const dry = mcp.callTool('dry_run', { operationId: plan.operationId });
  assert.equal(dry.status, 'PASS');
  assert.equal(dry.dryRun, true);
  assert.equal(dry.executed, false);
  assert.equal(dry.wouldChange.action, '状態を読む');

  const status = mcp.callTool('operation_status', { operationId: plan.operationId });
  assert.equal(status.operationStatus, 'planned');
});

test('the plan hash is stable for the same content regardless of key order', () => {
  const mcp = createOperationsMcp({});
  const a = mcp.callTool('operation_plan', planArgs({ changes: { a: 1, b: { y: 2, x: 1 } } }));
  const b = mcp.callTool('operation_plan', planArgs({ changes: { b: { x: 1, y: 2 }, a: 1 } }));
  assert.equal(a.planHash, b.planHash);
});

test('a write_external plan waits for approval and is not planned as executable', () => {
  const mcp = createOperationsMcp({});
  const plan = mcp.callTool('operation_plan', planArgs({ operationType: 'write_external' }));
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.operationStatus, 'awaiting_approval');
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.executed, false);
});

test('forbidden operation types are blocked and not stored', () => {
  const mcp = createOperationsMcp({});
  for (const type of FORBIDDEN_OPERATION_TYPES) {
    const payload = mcp.callTool('operation_plan', planArgs({ operationType: type }));
    assert.equal(payload.status, 'BLOCKED', type);
    assert.equal(payload.reasonCode, 'FORBIDDEN_OPERATION', type);
    assert.equal(payload.operationId, undefined, type);
  }
});

test('operation_plan rejects unknown fields and invalid operation types', () => {
  const mcp = createOperationsMcp({});
  assert.equal(mcp.callTool('operation_plan', planArgs({ operationType: 'nuke' })).status, 'FAIL');
  assert.equal(mcp.callTool('operation_plan', planArgs({ extra: true })).status, 'FAIL');
  assert.equal(mcp.callTool('operation_plan', { operationType: 'read' }).status, 'FAIL');
});

test('cancel stops a planned operation and dry-run then refuses it', () => {
  const mcp = createOperationsMcp({});
  const plan = mcp.callTool('operation_plan', planArgs());
  const cancelled = mcp.callTool('operation_cancel', { operationId: plan.operationId });
  assert.equal(cancelled.operationStatus, 'cancelled');
  assert.equal(mcp.callTool('dry_run', { operationId: plan.operationId }).status, 'FAIL');
  assert.equal(mcp.callTool('operation_cancel', { operationId: plan.operationId }).status, 'FAIL');
});

test('unknown operation ids return TARGET_NOT_FOUND', () => {
  const mcp = createOperationsMcp({});
  const payload = mcp.callTool('operation_status', { operationId: 'missing' });
  assert.equal(payload.reasonCode, 'TARGET_NOT_FOUND');
});

test('tool_schema_get returns the schema for a known tool and fails for an unknown one', () => {
  const mcp = createOperationsMcp({});
  assert.equal(mcp.callTool('tool_schema_get', { name: 'operation_plan' }).inputSchema.required.includes('operationType'), true);
  assert.equal(mcp.callTool('tool_schema_get', { name: 'nope' }).reasonCode, 'TARGET_NOT_FOUND');
});

test('tools/call with an unknown tool name is a JSON-RPC invalid-params error', () => {
  const res = createOperationsMcp({}).handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(res.error.code, -32602);
});

test('notifications are acknowledged without a response body and unknown methods get -32601', () => {
  const mcp = createOperationsMcp({});
  assert.equal(mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(mcp.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' }).error.code, -32601);
});

test('initialize reports the protocol version and server name', () => {
  const res = createOperationsMcp({}).handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.result.serverInfo.name, 'Clean Nano Operations MCP');
  assert.ok(res.result.protocolVersion);
});

// --- HTTP route ---

async function withServer(config, fn) {
  const app = createApp({ ...getConfig({}), mcpApiKey: 'k-operations', webhookApiKey: '', connectorApiKey: '', ...config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}/mcp/operations`); } finally { server.close(); }
}

test('POST /mcp/operations requires the MCP API key', async () => {
  await withServer({}, async (url) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(res.status, 401);
  });
});

test('POST /mcp/operations returns tools for an authorized client', async () => {
  await withServer({}, async (url) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k-operations' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.result.tools.length, EXPECTED_TOOLS.length);
  });
});

test('POST /mcp/operations acknowledges notifications with 202', async () => {
  await withServer({}, async (url) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k-operations' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(res.status, 202);
  });
});

test('the existing /mcp endpoint is unaffected by the new operations route', async () => {
  const app = createApp({ ...getConfig({}), mcpApiKey: 'k-operations', webhookApiKey: '' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k-operations' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(res.status, 200);
  } finally { server.close(); }
});
