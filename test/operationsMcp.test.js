'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createOperationsMcp, CATALOG, ALL_TOOL_NAMES, INTEGRATED_TOOL_NAMES, OPERATIONS_PUBLIC_TOOLS, FORBIDDEN_OPERATION_TYPES, APPROVAL_REQUIRED_TYPES } = require('../src/operationsMcp');
const { createMemoryStore } = require('../src/operations/store');

const EXPECTED_TOOLS = [
  'health_check', 'version_get', 'tools_list', 'tool_schema_get', 'capability_check', 'authentication_check',
  'permission_check', 'license_check', 'connection_test', 'environment_get', 'operation_plan',
  'operation_status', 'operation_cancel', 'dry_run', 'snapshot_create', 'operation_verify', 'audit_write',
  'rollback_execute', 'sp_site_get', 'sp_lists_list', 'sp_list_get', 'sp_list_schema_get', 'sp_item_get',
  'sp_item_query', 'sp_permissions_get',
  'sp_column_create', 'sp_column_update', 'sp_item_create', 'sp_item_update', 'sp_attachment_add',
  'sp_permissions_plan', 'sp_permissions_grant', 'sp_permissions_revoke'
];
const GUID = '11111111-2222-3333-4444-555555555555';
const planArgs = (overrides = {}) => ({
  operationType: 'read',
  targetEnvironmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
  targetObjectId: 'obj-1',
  action: '状態を読む',
  ...overrides
});

test('the catalogue contains every common and SharePoint tool, with no duplicate names', () => {
  assert.deepEqual([...ALL_TOOL_NAMES].sort(), [...EXPECTED_TOOLS].sort());
  assert.equal(new Set(ALL_TOOL_NAMES).size, ALL_TOOL_NAMES.length);
});

test('every tool carries all required contract fields with valid values', () => {
  const categories = ['READ', 'WRITE', 'VERIFY', 'RELEASE', 'PERMISSION', 'DELETE', 'BILLING', 'ROLLBACK'];
  for (const entry of CATALOG) {
    const m = entry.meta;
    assert.ok(categories.includes(m.category), `${entry.name} category`);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(m.riskLevel), `${entry.name} riskLevel`);
    for (const flag of ['requiresApproval', 'supportsDryRun', 'supportsRollback', 'auditRequired', 'additionalCost']) {
      assert.equal(typeof m[flag], 'boolean', `${entry.name} ${flag}`);
    }
    assert.ok(Array.isArray(m.requiredPermissions), `${entry.name} requiredPermissions`);
    assert.ok(Array.isArray(m.requiredConnections), `${entry.name} requiredConnections`);
    assert.equal(m.additionalCost, false, `${entry.name} must not add cost`);
    assert.equal(m.requiresApproval, m.category === 'ROLLBACK' || m.riskLevel === 'high' ? true : m.requiresApproval);
  }
  assert.equal(CATALOG.find((e) => e.name === 'rollback_execute').meta.requiresApproval, true);
});

test('approval and forbidden operation sets do not overlap', () => {
  for (const type of FORBIDDEN_OPERATION_TYPES) assert.equal(APPROVAL_REQUIRED_TYPES.includes(type), false, type);
});

test('the integrated set excludes health_check, which /mcp already serves', () => {
  assert.equal(INTEGRATED_TOOL_NAMES.includes('health_check'), false);
  assert.equal(INTEGRATED_TOOL_NAMES.length, EXPECTED_TOOLS.length - 1);
  assert.equal(OPERATIONS_PUBLIC_TOOLS.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'), true);
});

test('version_get reports the package version and the configured deployment SHA', async () => {
  const payload = await createOperationsMcp({ deploymentSha: 'abc123' }).callTool('version_get');
  assert.equal(payload.status, 'PASS');
  assert.equal(payload.internalName, 'clean-nano-operations');
  assert.equal(payload.deploymentSha, 'abc123');
  assert.match(payload.correlationId, /^[0-9a-f-]{36}$/);
});

test('capability_check lists every tool as implemented and reports live adapter state', async () => {
  const payload = await createOperationsMcp({}).callTool('capability_check');
  assert.equal(payload.status, 'PARTIAL');
  assert.equal(payload.implemented, EXPECTED_TOOLS.length);
  assert.ok(payload.tools.every((tool) => tool.implementationStatus === 'implemented'));
  assert.equal(payload.tools.find((tool) => tool.name === 'version_get').liveStatus, 'READY');
  assert.equal(payload.tools.find((tool) => tool.name === 'permission_check').liveStatus, 'NOT_CONFIGURED');
});

test('authentication_check reports presence only and never returns secret values', async () => {
  const secret = 'SECRET-VALUE-DO-NOT-LEAK-12345';
  const payload = await createOperationsMcp({ mcpApiKey: secret, mcpApiKeySource: 'CN_MCP_API_KEY' }).callTool('authentication_check');
  assert.equal(payload.activeVariable, 'CN_MCP_API_KEY');
  assert.equal(payload.legacyVariableInUse, false);
  assert.equal(JSON.stringify(payload).includes(secret), false);
});

test('authentication_check reports the legacy variable name when it is the active one', async () => {
  const payload = await createOperationsMcp({ mcpApiKey: 'legacy-key-value-1', mcpApiKeySource: 'MCP_API_KEY' }).callTool('authentication_check');
  assert.equal(payload.activeVariable, 'MCP_API_KEY');
  assert.equal(payload.legacyVariableInUse, true);
  assert.equal(JSON.stringify(payload).includes('legacy-key-value-1'), false);
});

test('authentication_check fails when neither key variable is configured', async () => {
  const payload = await createOperationsMcp({ mcpApiKey: '' }).callTool('authentication_check');
  assert.equal(payload.status, 'FAIL');
  assert.equal(payload.reasonCode, 'AUTH_CONFIG_MISSING');
  assert.equal(payload.activeVariable, null);
});

test('environment_get returns the confirmed profile values', async () => {
  const payload = await createOperationsMcp({}).callTool('environment_get');
  assert.equal(payload.profile.environmentId, '4d0aab59-43ec-ecf1-a9d1-869f2517adbb');
  assert.equal(payload.profile.solutionName, 'CN_CompanyOS_Core');
  assert.equal(payload.profile.sharePointSiteUrl, 'https://hisyoengineer.sharepoint.com/sites/cleannano');
  assert.equal(payload.profile.currentAppServiceEnvName, 'CN_MCP_API_KEY');
  assert.equal(Object.keys(payload.profile).some((key) => /secret|password|token/i.test(key)), false);
});

test('a read operation plan is planned, can be dry-run, and is never executed', async () => {
  const mcp = createOperationsMcp({});
  const plan = await mcp.callTool('operation_plan', planArgs());
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.operationStatus, 'planned');
  assert.equal(plan.approvalRequired, false);
  assert.equal(plan.executed, false);
  assert.match(plan.planHash, /^[0-9a-f]{64}$/);

  const dry = await mcp.callTool('dry_run', { operationId: plan.operationId });
  assert.equal(dry.status, 'PASS');
  assert.equal(dry.dryRun, true);
  assert.equal(dry.executed, false);
  assert.equal(dry.wouldChange.action, '状態を読む');

  const status = await mcp.callTool('operation_status', { operationId: plan.operationId });
  assert.equal(status.operationStatus, 'planned');
});

test('the plan hash is stable for the same content regardless of key order', async () => {
  const mcp = createOperationsMcp({});
  const a = await mcp.callTool('operation_plan', planArgs({ changes: { a: 1, b: { y: 2, x: 1 } } }));
  const b = await mcp.callTool('operation_plan', planArgs({ changes: { b: { x: 1, y: 2 }, a: 1 } }));
  assert.equal(a.planHash, b.planHash);
});

test('a write_external plan waits for approval and is not executable', async () => {
  const plan = await createOperationsMcp({}).callTool('operation_plan', planArgs({ operationType: 'write_external' }));
  assert.equal(plan.status, 'PASS');
  assert.equal(plan.operationStatus, 'awaiting_approval');
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.executed, false);
});

test('forbidden operation types are blocked and not stored', async () => {
  const mcp = createOperationsMcp({});
  for (const type of FORBIDDEN_OPERATION_TYPES) {
    const payload = await mcp.callTool('operation_plan', planArgs({ operationType: type }));
    assert.equal(payload.status, 'BLOCKED', type);
    assert.equal(payload.reasonCode, 'FORBIDDEN_OPERATION', type);
    assert.equal(payload.operationId, undefined, type);
  }
});

test('operation_plan rejects unknown fields and invalid operation types', async () => {
  const mcp = createOperationsMcp({});
  assert.equal((await mcp.callTool('operation_plan', planArgs({ operationType: 'nuke' }))).status, 'FAIL');
  assert.equal((await mcp.callTool('operation_plan', planArgs({ extra: true }))).status, 'FAIL');
  assert.equal((await mcp.callTool('operation_plan', { operationType: 'read' })).status, 'FAIL');
});

test('cancel stops a planned operation and dry-run then refuses it', async () => {
  const mcp = createOperationsMcp({});
  const plan = await mcp.callTool('operation_plan', planArgs());
  const cancelled = await mcp.callTool('operation_cancel', { operationId: plan.operationId });
  assert.equal(cancelled.operationStatus, 'cancelled');
  assert.equal((await mcp.callTool('dry_run', { operationId: plan.operationId })).status, 'FAIL');
  assert.equal((await mcp.callTool('operation_cancel', { operationId: plan.operationId })).status, 'FAIL');
});

test('unknown operation ids return TARGET_NOT_FOUND', async () => {
  const payload = await createOperationsMcp({}).callTool('operation_status', { operationId: 'missing' });
  assert.equal(payload.reasonCode, 'TARGET_NOT_FOUND');
});

test('tool_schema_get returns the schema for a known tool and fails for an unknown one', async () => {
  const mcp = createOperationsMcp({});
  assert.equal((await mcp.callTool('tool_schema_get', { name: 'operation_plan' })).inputSchema.required.includes('operationType'), true);
  assert.equal((await mcp.callTool('tool_schema_get', { name: 'nope' })).reasonCode, 'TARGET_NOT_FOUND');
});

test('an invalid correlationId is rejected by validation rather than silently replaced', async () => {
  const payload = await createOperationsMcp({}).callTool('version_get', { correlationId: 'bad id!' });
  assert.equal(payload.status, 'FAIL');
  assert.equal(payload.reasonCode, 'VALIDATION_FAILED');
});

test('a supplied correlationId is echoed back for traceability', async () => {
  const payload = await createOperationsMcp({}).callTool('version_get', { correlationId: 'trace-abc-12345' });
  assert.equal(payload.correlationId, 'trace-abc-12345');
});

test('JSON-RPC tools/call with an unknown tool name is a JSON-RPC invalid-params error', async () => {
  const res = await createOperationsMcp({}).handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(res.error.code, -32602);
});

test('notifications are acknowledged without a response and unknown methods get -32601', async () => {
  const mcp = createOperationsMcp({});
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).error.code, -32601);
});

test('initialize reports the protocol version and server name', async () => {
  const res = await createOperationsMcp({}).handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.result.serverInfo.name, 'Clean Nano Operations MCP');
  assert.ok(res.result.protocolVersion);
});

test('tools/list over JSON-RPC returns every tool with an input schema', async () => {
  const res = await createOperationsMcp({}).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(res.result.tools.length, EXPECTED_TOOLS.length);
  assert.ok(res.result.tools.every((tool) => tool.inputSchema && tool.annotations));
});

test('a tool result is marked isError when the status is FAIL or BLOCKED', async () => {
  const mcp = createOperationsMcp({});
  const res = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'permission_check', arguments: { scope: 'sharepoint', requiredPermissions: ['x'] } } });
  assert.equal(res.result.structuredContent.status, 'BLOCKED');
  assert.equal(res.result.isError, true);
  assert.equal(res.result.content[0].type, 'text');
});

test('the audit store is never exposed with delete or clear operations', () => {
  const store = createMemoryStore();
  assert.equal(['delete', 'remove', 'clear', 'purge'].some((name) => typeof store[name] === 'function'), false);
});
