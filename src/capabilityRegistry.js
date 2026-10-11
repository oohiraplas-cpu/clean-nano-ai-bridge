// Registration is not evidence of live execution. This read-only registry never
// accepts caller-supplied verification assertions or mutates external systems.
const SYSTEMS = Object.freeze(['Power Apps', 'Power Automate', 'SharePoint', 'GitHub', 'Azure', 'Copilot Studio', 'Teams', 'Outlook', 'OneDrive', 'Entra ID', 'Bridge', 'CNAI']);
const CAPABILITIES = Object.freeze(['READ', 'DISCOVER', 'WRITE', 'CREATE', 'UPDATE', 'SAVE', 'PUBLISH', 'ENABLE', 'RUN', 'VERIFY', 'ROLLBACK', 'AUDIT']);
const REQUIRED = Object.freeze({
  'Power Apps': 'resolve_app_target get_powerapps_app get_powerapps_state get_powerapps_source update_powerapps_source save_powerapps_app publish_powerapps_app get_powerapps_operation_result verify_powerapps_runtime rollback_powerapps_operation',
  'Power Automate': 'list_flows get_flow_definition validate_flow_connection create_or_update_flow save_flow test_flow enable_flow disable_flow get_flow_run_history verify_flow_runtime rollback_flow',
  SharePoint: 'resolve_site list_lists get_list_schema compare_list_schema create_missing_column configure_choice configure_lookup create_item update_item upload_file re_read_item verify_schema verify_permissions',
  GitHub: 'get_repository_state get_branch compare_sha create_branch read_file update_file commit push create_pr get_ci_result merge_approved_pr verify_main_sha',
  Azure: 'health_check get_deployment_sha get_runtime_sha get_logs deploy_staging warmup_staging verify_staging swap_to_production restart_if_safe rollback_deployment verify_runtime',
  'Copilot Studio': 'resolve_agent get_agent_state get_tools compare_tools register_bridge_tool update_agent_instructions save_agent publish_agent run_agent_tool_test verify_published_agent',
  CNAI: 'get_execution_queue create_execution_package dispatch_agent get_execution_status record_evidence record_incident resume_from_checkpoint set_priority'
});
// Only exact, existing contracts are reused. Similar names do not imply equivalence.
function getCapabilityRegistry(tools, runtimeSha = null) {
  const registered = new Map(tools.map(tool => [tool.name, tool]));
  return {
    status: 'UNVERIFIED', toolContractVersion: '1.0.0', bridgeRuntimeSha: runtimeSha,
    verificationScope: 'registration_only', cnaiTools: null,
    cnaiComparisonStatus: 'BLOCKED_CONNECTION',
    capabilities: SYSTEMS.flatMap(targetSystem => CAPABILITIES.map(capability => ({
      targetSystem, capability, status: 'UNVERIFIED', lastVerifiedAt: null,
      reason: 'No target-bound live capability evidence loaded'
    }))),
    methods: Object.entries(REQUIRED).flatMap(([targetSystem, names]) => names.split(' ').map(toolName => {
      const tool = registered.get(toolName);
      // health_check is Bridge health, not Azure deployment verification.
      const exists = Boolean(tool) && !(targetSystem === 'Azure' && toolName === 'health_check');
      return { targetSystem, toolName, status: exists ? 'UNVERIFIED' : 'NOT_IMPLEMENTED',
        registered: exists, inputSchema: exists ? tool.inputSchema : null,
        outputSchema: exists ? (tool.outputSchema || null) : null,
        description: exists ? tool.description : null,
        riskClass: 'UNCLASSIFIED', approvalRequired: null, rollbackSupported: null,
        lastVerifiedAt: null, bridgeRuntimeSha: runtimeSha, toolContractVersion: '1.0.0',
        synchronizationEligible: false };
    })),
    synchronizationEligibleTools: [],
    blockers: ['Live runtime identity verification required', 'CNAI agent identity and authenticated tool inventory required', 'Live channel evidence required before synchronization completion']
  };
}
module.exports = { SYSTEMS, CAPABILITIES, REQUIRED, getCapabilityRegistry };
