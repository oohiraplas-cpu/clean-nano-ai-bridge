const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AGENT_DEFINITIONS,
  buildToolRegistry,
  validateAgentTools,
  getAgentRegistry
} = require('../src/agentRegistry');
const { MCP_PUBLIC_TOOLS, MCP_METHODS } = require('../src/server');

const EXPECTED_AGENT_IDS = [
  'CommanderAI', 'ResearchAI', 'DesignAI', 'ImplementationAI', 'TestAI', 'AuditAI',
  'ReleaseAI', 'RecoveryAI', 'ProfitAI', 'CollectionAI', 'OptimizationAI'
];

test('Agent Registry は指定された11エージェントをすべて登録する', () => {
  assert.deepEqual(AGENT_DEFINITIONS.map((agent) => agent.id), EXPECTED_AGENT_IDS);
  assert.equal(new Set(AGENT_DEFINITIONS.map((agent) => agent.id)).size, EXPECTED_AGENT_IDS.length, 'IDに重複なし');
});

test('全エージェントの使用ツールは公開ツール（Tool Registry）に存在する', () => {
  const toolRegistry = buildToolRegistry(MCP_PUBLIC_TOOLS);
  const result = validateAgentTools(AGENT_DEFINITIONS, toolRegistry);
  assert.deepEqual(result.unknownTools, []);
  assert.equal(result.ok, true);
});

test('人間承認が必要な操作は、そのエージェントの使用ツールに含まれる', () => {
  for (const agent of AGENT_DEFINITIONS) {
    for (const tool of agent.humanApprovalRequired) {
      assert.ok(agent.allowedTools.includes(tool), `${agent.id}: ${tool}`);
    }
  }
});

test('公開・権限変更・ロールバック・保存を伴うツールは人間承認対象になっている', () => {
  const byId = Object.fromEntries(AGENT_DEFINITIONS.map((agent) => [agent.id, agent]));
  assert.ok(byId.ReleaseAI.humanApprovalRequired.includes('publish_powerapps_app'));
  assert.ok(byId.ReleaseAI.humanApprovalRequired.includes('deploy_to_test'));
  assert.ok(byId.RecoveryAI.humanApprovalRequired.includes('rollback_deployment'));
  assert.ok(byId.ImplementationAI.humanApprovalRequired.includes('save_powerapps_app'));
});

test('ProfitAI と CollectionAI は読み取り専用ツールのみを使う', () => {
  const toolRegistry = buildToolRegistry(MCP_PUBLIC_TOOLS);
  for (const id of ['ProfitAI', 'CollectionAI']) {
    const agent = AGENT_DEFINITIONS.find((item) => item.id === id);
    for (const tool of agent.allowedTools) {
      assert.equal(toolRegistry.get(tool).readOnly, true, `${id} -> ${tool} は読み取り専用であるべき`);
    }
  }
});

test('未登録ツールを参照する定義は検出される', () => {
  const toolRegistry = buildToolRegistry([{ name: 'health_check' }]);
  const result = validateAgentTools(
    [{ id: 'X', allowedTools: ['health_check', 'missing_tool'], humanApprovalRequired: [] }],
    toolRegistry
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknownTools, [{ agentId: 'X', tool: 'missing_tool' }]);
});

test('承認対象が allowedTools に無い場合も検出される', () => {
  const toolRegistry = buildToolRegistry([{ name: 'a' }, { name: 'b' }]);
  const result = validateAgentTools(
    [{ id: 'Y', allowedTools: ['a'], humanApprovalRequired: ['b'] }],
    toolRegistry
  );
  assert.equal(result.ok, false);
  assert.equal(result.unknownTools[0].agentId, 'Y');
});

test('getAgentRegistry は読み取り専用で、件数・Capability Registry・整合性を返す', () => {
  const registry = getAgentRegistry({ publicTools: MCP_PUBLIC_TOOLS });
  assert.equal(registry.readOnly, true);
  assert.equal(registry.status, '正常');
  assert.equal(registry.agentCount, 11);
  assert.equal(registry.toolRegistryCount, MCP_PUBLIC_TOOLS.length);
  assert.equal(registry.validation.ok, true);
  assert.ok(registry.capabilityRegistry.includes('task_orchestration'));
  assert.deepEqual(registry.capabilityRegistry, [...registry.capabilityRegistry].sort());
  const release = registry.agents.find((agent) => agent.id === 'ReleaseAI');
  assert.ok(release.allowedTools.every((tool) => tool.registered === true));
});

test('get_agent_registry は MCP_METHODS と MCP_PUBLIC_TOOLS の両方に登録され、既存の並びを壊さない', () => {
  assert.ok(MCP_METHODS.includes('get_agent_registry'));
  const tool = MCP_PUBLIC_TOOLS.find((entry) => entry.name === 'get_agent_registry');
  assert.ok(tool, 'public tool として公開');
  assert.equal(tool.annotations.readOnlyHint, true);
  const names = MCP_PUBLIC_TOOLS.map((entry) => entry.name);
  assert.ok(names.indexOf('get_agent_registry') < names.indexOf('create_execution_request'), '実行キュー系より前に追加');
});
