/**
 * Agent Registry
 *
 * Bridge に登録する AI エージェントの定義と、Tool Registry（公開ツール）との整合性検証を提供する。
 * 読み取り専用。エージェントの定義は静的データであり、外部APIには触れない。
 *
 * 規則:
 * - 各エージェントが使えるツールは、公開ツール一覧（Tool Registry）に存在する名前だけ。
 * - 書込み・公開・課金・権限変更を伴う操作は humanApprovalRequired に列挙し、
 *   人間の承認なしに自動実行されないことを示す（CLAUDE.md の承認ゲート規則に従う）。
 */

const AGENT_DEFINITIONS = Object.freeze([
  {
    id: 'CommanderAI',
    name: 'CommanderAI',
    role: '指令・タスク配分',
    capabilities: ['task_orchestration', 'status_tracking'],
    allowedTools: ['get_bridge_capabilities', 'check_dependencies', 'get_tasks', 'get_next_task', 'create_task', 'update_task_status', 'get_task_result'],
    humanApprovalRequired: []
  },
  {
    id: 'ResearchAI',
    name: 'ResearchAI',
    role: '現状調査・構造把握',
    capabilities: ['app_discovery', 'structure_inspection'],
    allowedTools: ['list_power_apps', 'get_powerapps_app', 'get_powerapps_state', 'get_powerapps_source', 'inspect_powerapps_structure', 'discover_powerapps_structure', 'get_sharepoint_list_schema'],
    humanApprovalRequired: []
  },
  {
    id: 'DesignAI',
    name: 'DesignAI',
    role: '画面・UI設計',
    capabilities: ['ui_design', 'ui_control_state'],
    allowedTools: ['get_powerapps_source', 'prepare_powerapps_execution', 'generate_ui_control_state'],
    humanApprovalRequired: []
  },
  {
    id: 'ImplementationAI',
    name: 'ImplementationAI',
    role: '実装（既存ソースへの最小差分修正）',
    capabilities: ['source_edit', 'change_validation'],
    allowedTools: ['get_powerapps_source', 'validate_powerapps_change', 'compare_powerapps_with_git', 'update_powerapps_app', 'save_powerapps_app'],
    humanApprovalRequired: ['save_powerapps_app']
  },
  {
    id: 'TestAI',
    name: 'TestAI',
    role: 'テスト・検証',
    capabilities: ['test_execution', 'save_result_verification'],
    allowedTools: ['run_powerapps_tests', 'verify_save_result', 'validate_powerapps_source'],
    humanApprovalRequired: []
  },
  {
    id: 'AuditAI',
    name: 'AuditAI',
    role: '監査・証跡確認',
    capabilities: ['audit_review', 'evidence_export'],
    allowedTools: ['get_deployment_logs', 'export_evidence', 'get_task_result', 'get_permissions'],
    humanApprovalRequired: []
  },
  {
    id: 'ReleaseAI',
    name: 'ReleaseAI',
    role: 'リリース（テスト環境反映・本番公開の準備）',
    capabilities: ['deploy_to_test', 'deployment_verification'],
    allowedTools: ['deploy_to_test', 'verify_deployment', 'publish_powerapps_app', 'get_powerapps_operation_result'],
    humanApprovalRequired: ['deploy_to_test', 'publish_powerapps_app']
  },
  {
    id: 'RecoveryAI',
    name: 'RecoveryAI',
    role: '障害時の切り戻し・復旧',
    capabilities: ['rollback', 'dependency_diagnosis'],
    allowedTools: ['rollback_deployment', 'check_dependencies', 'get_deployment_logs'],
    humanApprovalRequired: ['rollback_deployment']
  },
  {
    id: 'ProfitAI',
    name: 'ProfitAI',
    role: '利益・経営指標の確認（読み取りのみ）',
    capabilities: ['executive_brief', 'profit_review'],
    allowedTools: ['get_executive_policy', 'get_executive_brief'],
    humanApprovalRequired: []
  },
  {
    id: 'CollectionAI',
    name: 'CollectionAI',
    role: '入金回収の進捗確認（読み取りのみ）',
    capabilities: ['collection_review'],
    allowedTools: ['get_executive_brief'],
    humanApprovalRequired: []
  },
  {
    id: 'OptimizationAI',
    name: 'OptimizationAI',
    role: '既存資産の再利用・改善提案',
    capabilities: ['reuse_pattern', 'playbook_lookup'],
    allowedTools: ['suggest_reuse_pattern', 'get_playbook', 'get_application_rules'],
    humanApprovalRequired: []
  }
]);

/**
 * 公開ツール一覧から Tool Registry を作る。
 * @param {Array<{name: string, annotations?: {readOnlyHint?: boolean}}>} publicTools
 * @returns {Map<string, {name: string, readOnly: boolean}>}
 */
function buildToolRegistry(publicTools) {
  const registry = new Map();
  for (const tool of publicTools) {
    registry.set(tool.name, {
      name: tool.name,
      readOnly: tool.annotations?.readOnlyHint === true
    });
  }
  return registry;
}

/**
 * エージェント定義を検証し、Tool Registry に存在しないツール参照を列挙する。
 * @param {typeof AGENT_DEFINITIONS} agents
 * @param {Map<string, object>} toolRegistry
 * @returns {{ok: boolean, unknownTools: Array<{agentId: string, tool: string}>}}
 */
function validateAgentTools(agents, toolRegistry) {
  const unknownTools = [];
  for (const agent of agents) {
    for (const tool of agent.allowedTools) {
      if (!toolRegistry.has(tool)) unknownTools.push({ agentId: agent.id, tool });
    }
    for (const tool of agent.humanApprovalRequired) {
      if (!agent.allowedTools.includes(tool)) unknownTools.push({ agentId: agent.id, tool: `${tool}（承認対象だが allowedTools に無い）` });
    }
  }
  return { ok: unknownTools.length === 0, unknownTools };
}

/**
 * Agent Registry の一覧を返す（読み取り専用）。
 * @param {{publicTools: Array}} options
 * @returns {object}
 */
function getAgentRegistry({ publicTools = [] } = {}) {
  const toolRegistry = buildToolRegistry(publicTools);
  const validation = validateAgentTools(AGENT_DEFINITIONS, toolRegistry);

  const agents = AGENT_DEFINITIONS.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: '有効',
    capabilities: [...agent.capabilities],
    allowedTools: agent.allowedTools.map((tool) => {
      const entry = toolRegistry.get(tool);
      return { name: tool, registered: Boolean(entry), readOnly: entry ? entry.readOnly : null };
    }),
    humanApprovalRequired: [...agent.humanApprovalRequired]
  }));

  const capabilityRegistry = [...new Set(AGENT_DEFINITIONS.flatMap((agent) => agent.capabilities))].sort();

  return {
    status: validation.ok ? '正常' : '不整合あり',
    readOnly: true,
    agentCount: agents.length,
    toolRegistryCount: toolRegistry.size,
    capabilityRegistry,
    validation,
    agents
  };
}

module.exports = {
  AGENT_DEFINITIONS,
  buildToolRegistry,
  validateAgentTools,
  getAgentRegistry
};
