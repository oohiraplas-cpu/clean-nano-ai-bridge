'use strict';

// Agent Registry: an execution layer on top of the capability model in bridgeCapabilities.js.
// Each agent declares the tools it may call, the capability classes it needs, its risk level,
// and approval rules. Tool capability is never declared by agents; it is derived from the
// shared classifiers (readOnly / requiresApproval), so there is a single source of truth.

const { categorizeTool, isReadOnlyTool, requiresApprovalTool } = require('./bridgeCapabilities');

const CAPABILITIES = Object.freeze(['read', 'write', 'approval']);
const RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
const CAPABILITY_RISK = Object.freeze({ read: 'low', write: 'medium', approval: 'high' });

// Tools no agent may hold, regardless of approval (permission changes are never delegated to an agent).
const GLOBALLY_FORBIDDEN_TOOLS = Object.freeze(['update_permissions']);
// Tools that only ReleaseAI may hold (non-production deploy and production publish paths).
const RELEASE_ONLY_TOOLS = Object.freeze(['deploy_to_test', 'verify_deployment', 'publish_powerapps_app']);
const RELEASE_AGENT = 'ReleaseAI';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const AGENT_DEFINITIONS = deepFreeze([
  {
    id: 'CommanderAI', role: '全体の目的解釈・優先順位付け・実行指示',
    allowedCapabilities: ['read'],
    allowedTools: ['health_check', 'check_dependencies', 'get_tasks', 'get_next_task', 'get_task_result', 'get_executive_policy'],
    riskLevel: 'low', approvalRules: []
  },
  {
    id: 'ResearchAI', role: 'Power Apps・SharePointの現状調査（読み取りのみ）',
    allowedCapabilities: ['read'],
    allowedTools: ['get_powerapps_app', 'get_powerapps_state', 'get_powerapps_source', 'get_powerapps_operation_result', 'get_sharepoint_list', 'get_sharepoint_columns', 'get_executive_brief'],
    riskLevel: 'low', approvalRules: []
  },
  {
    id: 'DesignAI', role: '変更設計・構造解析（書込みなし）',
    allowedCapabilities: ['read', 'write'],
    allowedTools: ['get_powerapps_source', 'get_sharepoint_columns', 'discover_powerapps_structure', 'inspect_powerapps_structure', 'validate_powerapps_source'],
    riskLevel: 'medium', approvalRules: []
  },
  {
    id: 'ImplementationAI', role: '最小差分のソース更新と保存（公開は含まない）',
    allowedCapabilities: ['read', 'write'],
    allowedTools: ['get_powerapps_source', 'update_powerapps_app', 'save_powerapps_app', 'validate_powerapps_change'],
    riskLevel: 'medium',
    approvalRules: [{ tool: 'save_powerapps_app', rule: 'stateContext取得済み・branch=canonical（Bridgeが検証）' }]
  },
  {
    id: 'TestAI', role: '静的検査・保存後検証（書込みなし）',
    allowedCapabilities: ['read', 'write'],
    allowedTools: ['get_powerapps_source', 'run_powerapps_tests', 'validate_powerapps_change', 'verify_save_result'],
    riskLevel: 'medium', approvalRules: []
  },
  {
    id: 'AuditAI', role: '実行結果・権限・ログの監査（読み取りのみ）',
    allowedCapabilities: ['read'],
    allowedTools: ['get_powerapps_operation_result', 'get_deployment_logs', 'get_permissions', 'get_task_result', 'get_powerapps_state', 'check_dependencies'],
    riskLevel: 'low', approvalRules: []
  },
  {
    id: 'ReleaseAI', role: '非本番デプロイと本番公開（人間承認必須）',
    allowedCapabilities: ['read', 'write', 'approval'],
    allowedTools: ['get_powerapps_state', 'get_powerapps_source', 'deploy_to_test', 'verify_deployment', 'publish_powerapps_app'],
    riskLevel: 'high',
    approvalRules: [
      { tool: 'publish_powerapps_app', rule: '対象操作への社長の明示承認を実行直前に必須。source-bound stateSessionId・DEPLOYMENT_SHA一致をBridgeが検証' }
    ]
  },
  {
    id: 'RecoveryAI', role: '直前の正常状態への復旧（人間承認必須）',
    allowedCapabilities: ['read', 'approval'],
    allowedTools: ['get_deployment_logs', 'get_powerapps_operation_result', 'rollback_deployment'],
    riskLevel: 'high',
    approvalRules: [
      { tool: 'rollback_deployment', rule: 'verify_deploymentでverified済みの復旧元のみ。本番はapprovedByHuman:true必須' }
    ]
  },
  {
    id: 'ProfitAI', role: '利益・粗利の経営資料確認（読み取りのみ）',
    allowedCapabilities: ['read'],
    allowedTools: ['get_executive_brief', 'get_executive_policy', 'get_sharepoint_list'],
    riskLevel: 'low', approvalRules: []
  },
  {
    id: 'CollectionAI', role: '未入金・入金回収の確認（読み取りのみ）',
    allowedCapabilities: ['read'],
    allowedTools: ['get_sharepoint_list', 'get_sharepoint_columns', 'get_executive_brief'],
    riskLevel: 'low', approvalRules: []
  },
  {
    id: 'OptimizationAI', role: '既存資産・構成の改善提案（読み取りのみ）',
    allowedCapabilities: ['read'],
    allowedTools: ['get_executive_policy', 'get_powerapps_source', 'get_sharepoint_columns', 'get_task_result'],
    riskLevel: 'low', approvalRules: []
  }
]);

function toolCapability(name) {
  if (requiresApprovalTool(name)) return 'approval';
  if (isReadOnlyTool(name)) return 'read';
  return 'write';
}

function maxRisk(levels) {
  return levels.reduce((max, level) => (RISK_LEVELS.indexOf(level) > RISK_LEVELS.indexOf(max) ? level : max), 'low');
}

/**
 * Build the agent registry from declared definitions and the public tool list.
 * Returns { agents, validation }. Validation errors never silently drop an agent or a tool.
 */
function buildAgentRegistry(publicTools, definitions = AGENT_DEFINITIONS) {
  const toolNames = new Set(publicTools.map((tool) => tool.name));
  const errors = [];
  const seenIds = new Set();

  const agents = definitions.map((def) => {
    const prefix = def.id;
    if (seenIds.has(def.id)) errors.push(`${prefix}: id が重複しています`);
    seenIds.add(def.id);
    if (!RISK_LEVELS.includes(def.riskLevel)) errors.push(`${prefix}: riskLevel が不正です (${def.riskLevel})`);
    for (const capability of def.allowedCapabilities) {
      if (!CAPABILITIES.includes(capability)) errors.push(`${prefix}: 未知の capability (${capability})`);
    }

    const tools = [];
    for (const name of def.allowedTools) {
      if (!toolNames.has(name)) {
        errors.push(`${prefix}: 公開ツールに存在しません (${name})`);
        continue;
      }
      if (GLOBALLY_FORBIDDEN_TOOLS.includes(name)) {
        errors.push(`${prefix}: 権限変更ツールはどのAgentにも割り当てできません (${name})`);
        continue;
      }
      if (RELEASE_ONLY_TOOLS.includes(name) && def.id !== RELEASE_AGENT) {
        errors.push(`${prefix}: ${name} は ${RELEASE_AGENT} のみ保持できます`);
        continue;
      }
      const capability = toolCapability(name);
      if (!def.allowedCapabilities.includes(capability)) {
        errors.push(`${prefix}: capability ${capability} が許可されていません (${name})`);
        continue;
      }
      tools.push({ name, capability, category: categorizeTool(name), riskLevel: CAPABILITY_RISK[capability] });
    }

    const computedRisk = maxRisk(tools.map((tool) => tool.riskLevel));
    if (RISK_LEVELS.indexOf(def.riskLevel) < RISK_LEVELS.indexOf(computedRisk)) {
      errors.push(`${prefix}: riskLevel ${def.riskLevel} は保持ツールのリスク ${computedRisk} を下回っています`);
    }

    const approvalTools = tools.filter((tool) => tool.capability === 'approval').map((tool) => tool.name);
    for (const name of approvalTools) {
      if (!def.approvalRules.some((rule) => rule.tool === name)) errors.push(`${prefix}: 承認必須ツール ${name} の approvalRules がありません`);
    }
    for (const rule of def.approvalRules) {
      if (!def.allowedTools.includes(rule.tool)) errors.push(`${prefix}: approvalRules が未許可ツールを参照しています (${rule.tool})`);
    }

    return {
      id: def.id,
      role: def.role,
      riskLevel: def.riskLevel,
      computedRiskLevel: computedRisk,
      allowedCapabilities: [...def.allowedCapabilities],
      allowedTools: tools,
      approvalRules: def.approvalRules.map((rule) => ({ ...rule })),
    };
  });

  return {
    agentCount: agents.length,
    capabilityModel: { capabilities: [...CAPABILITIES], riskByCapability: { ...CAPABILITY_RISK } },
    agents,
    validation: { ok: errors.length === 0, errors }
  };
}

function getAgentRegistry(publicTools) {
  return buildAgentRegistry(publicTools);
}

module.exports = {
  AGENT_DEFINITIONS,
  buildAgentRegistry,
  getAgentRegistry,
  toolCapability
};
