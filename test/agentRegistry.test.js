const assert = require('node:assert/strict');
const test = require('node:test');
const { getConfig } = require('../src/config');
const { createApp, MCP_PUBLIC_TOOLS, MCP_METHODS } = require('../src/server');
const { AGENT_DEFINITIONS, buildAgentRegistry, getAgentRegistry, toolCapability } = require('../src/agentRegistry');

const EXPECTED_IDS = [
  'CommanderAI', 'ResearchAI', 'DesignAI', 'ImplementationAI', 'TestAI', 'AuditAI',
  'ReleaseAI', 'RecoveryAI', 'ProfitAI', 'CollectionAI', 'OptimizationAI'
];

function clone(definitions) {
  return definitions.map((def) => ({ ...def, allowedCapabilities: [...def.allowedCapabilities], allowedTools: [...def.allowedTools], approvalRules: def.approvalRules.map((rule) => ({ ...rule })) }));
}

function withAgent(id, patch) {
  const defs = clone(AGENT_DEFINITIONS);
  const index = defs.findIndex((def) => def.id === id);
  assert.notEqual(index, -1, `fixture agent ${id} must exist`);
  defs[index] = { ...defs[index], ...patch };
  return defs;
}

function errorsFor(definitions) {
  return buildAgentRegistry(MCP_PUBLIC_TOOLS, definitions).validation.errors;
}

test('登録Agentは要求どおり11役割で、IDが一致する', () => {
  const registry = getAgentRegistry(MCP_PUBLIC_TOOLS);
  assert.equal(registry.agentCount, 11);
  assert.deepEqual(registry.agents.map((agent) => agent.id), EXPECTED_IDS);
});

test('各Agentは allowedTools / allowedCapabilities / riskLevel / approvalRules を持つ', () => {
  const registry = getAgentRegistry(MCP_PUBLIC_TOOLS);
  for (const agent of registry.agents) {
    assert.ok(Array.isArray(agent.allowedTools), `${agent.id}.allowedTools`);
    assert.ok(agent.allowedTools.length > 0, `${agent.id} has tools`);
    assert.ok(Array.isArray(agent.allowedCapabilities) && agent.allowedCapabilities.length > 0, `${agent.id}.allowedCapabilities`);
    assert.ok(['low', 'medium', 'high'].includes(agent.riskLevel), `${agent.id}.riskLevel`);
    assert.ok(Array.isArray(agent.approvalRules), `${agent.id}.approvalRules`);
  }
});

test('既定定義はvalidation.ok=trueで、エラーなし', () => {
  const registry = getAgentRegistry(MCP_PUBLIC_TOOLS);
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.deepEqual(registry.validation.errors, []);
});

test('読み取り専用Agentは write/approval ツールを持たない', () => {
  const registry = getAgentRegistry(MCP_PUBLIC_TOOLS);
  for (const id of ['CommanderAI', 'ResearchAI', 'AuditAI', 'ProfitAI', 'CollectionAI', 'OptimizationAI']) {
    const agent = registry.agents.find((a) => a.id === id);
    assert.deepEqual(agent.allowedCapabilities, ['read'], id);
    assert.ok(agent.allowedTools.every((tool) => tool.capability === 'read'), `${id} only read tools`);
  }
});

test('承認必須ツールは、対応する approvalRules を持つ', () => {
  const registry = getAgentRegistry(MCP_PUBLIC_TOOLS);
  for (const agent of registry.agents) {
    for (const tool of agent.allowedTools.filter((t) => t.capability === 'approval')) {
      assert.ok(agent.approvalRules.some((rule) => rule.tool === tool.name), `${agent.id}/${tool.name} needs approvalRule`);
    }
  }
});

test('ツール capability は Capability Registry（分類器）から導出される', () => {
  assert.equal(toolCapability('health_check'), 'read');
  assert.equal(toolCapability('get_agent_registry'), 'read');
  assert.equal(toolCapability('save_powerapps_app'), 'write');
  assert.equal(toolCapability('publish_powerapps_app'), 'approval');
  const registry = getAgentRegistry(MCP_PUBLIC_TOOLS);
  for (const agent of registry.agents) {
    for (const tool of agent.allowedTools) {
      assert.equal(tool.capability, toolCapability(tool.name), `${agent.id}/${tool.name}`);
    }
  }
});

test('異常系: 公開ツールに存在しないツールは拒否される', () => {
  const errors = errorsFor(withAgent('ResearchAI', { allowedTools: ['get_powerapps_app', 'no_such_tool'] }));
  assert.ok(errors.some((e) => e.startsWith('ResearchAI: 公開ツールに存在しません (no_such_tool)')), errors.join('\n'));
});

test('異常系: 許可されていない capability のツールは拒否される', () => {
  // ImplementationAI は read/write のみ。approval ツール(rollback_deployment)を混ぜると拒否される。
  const errors = errorsFor(withAgent('ImplementationAI', { allowedTools: ['get_powerapps_source', 'rollback_deployment'] }));
  assert.ok(errors.some((e) => e.includes('capability approval が許可されていません (rollback_deployment)')), errors.join('\n'));
});

test('異常系: riskLevel が保持ツールのリスクを下回ると拒否される', () => {
  const errors = errorsFor(withAgent('ImplementationAI', { riskLevel: 'low' }));
  assert.ok(errors.some((e) => e.startsWith('ImplementationAI: riskLevel low は保持ツールのリスク')), errors.join('\n'));
});

test('異常系: 承認必須ツールに approvalRules が無いと拒否される', () => {
  const errors = errorsFor(withAgent('RecoveryAI', { approvalRules: [] }));
  assert.ok(errors.some((e) => e.includes('承認必須ツール rollback_deployment の approvalRules がありません')), errors.join('\n'));
});

test('異常系: 未許可ツールを参照する approvalRules は拒否される', () => {
  const errors = errorsFor(withAgent('AuditAI', { approvalRules: [{ tool: 'publish_powerapps_app', rule: 'x' }] }));
  assert.ok(errors.some((e) => e.includes('approvalRules が未許可ツールを参照しています (publish_powerapps_app)')), errors.join('\n'));
});

test('異常系: update_permissions はどのAgentにも割り当てできない', () => {
  const errors = errorsFor(withAgent('CommanderAI', { allowedTools: ['health_check', 'update_permissions'] }));
  assert.ok(errors.some((e) => e.includes('権限変更ツールはどのAgentにも割り当てできません (update_permissions)')), errors.join('\n'));
});

test('異常系: 本番系ツール（ReleaseAI専用）を他Agentへ割り当てると拒否される', () => {
  for (const tool of ['deploy_to_test', 'verify_deployment', 'publish_powerapps_app']) {
    const defs = withAgent('RecoveryAI', { allowedCapabilities: ['read', 'write', 'approval'], allowedTools: ['get_deployment_logs', tool] });
    const errors = errorsFor(defs);
    assert.ok(errors.some((e) => e.includes(`${tool} は ReleaseAI のみ保持できます`)), `${tool}: ${errors.join('\n')}`);
  }
});

test('異常系: Agent ID の重複は拒否される', () => {
  const defs = clone(AGENT_DEFINITIONS);
  defs.push({ ...defs[0] });
  const errors = errorsFor(defs);
  assert.ok(errors.some((e) => e === 'CommanderAI: id が重複しています'), errors.join('\n'));
});

test('異常系: 不正な riskLevel / capability は拒否される', () => {
  const errors = errorsFor(withAgent('TestAI', { riskLevel: 'extreme', allowedCapabilities: ['read', 'admin'] }));
  assert.ok(errors.some((e) => e.includes('riskLevel が不正です (extreme)')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('未知の capability (admin)')), errors.join('\n'));
});

test('Agent定義は凍結され、外部から改変できない', () => {
  assert.ok(Object.isFrozen(AGENT_DEFINITIONS));
  assert.ok(Object.isFrozen(AGENT_DEFINITIONS[0]));
  assert.ok(Object.isFrozen(AGENT_DEFINITIONS[0].allowedTools));
  assert.ok(Object.isFrozen(AGENT_DEFINITIONS[0].approvalRules));
  assert.equal(AGENT_DEFINITIONS[0].riskLevel, 'low');
});

test('get_agent_registry はMCPの公開ツール・メソッドに登録され、読み取り専用', () => {
  assert.ok(MCP_PUBLIC_TOOLS.some((tool) => tool.name === 'get_agent_registry'));
  assert.ok(MCP_METHODS.includes('get_agent_registry'));
  const tool = MCP_PUBLIC_TOOLS.find((t) => t.name === 'get_agent_registry');
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test('get_agent_registry をMCP経由で呼ぶと、直接呼び出しと同じ結果を返す', async (t) => {
  const key = 'agent-registry-test-key';
  const config = getConfig({});
  config.mcpApiKey = key;
  const app = createApp(config);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'Mcp-Session-Id': 'agent-registry-session' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_agent_registry', arguments: {} } })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, false);
  const data = body.result.structuredContent;
  const direct = getAgentRegistry(MCP_PUBLIC_TOOLS);
  assert.equal(data.agentCount, 11);
  assert.deepEqual(data.agents.map((a) => a.id), direct.agents.map((a) => a.id));
  assert.deepEqual(data.validation, direct.validation);
});
