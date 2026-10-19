'use strict';
/** Compatibility registry. Existing tool definitions remain the sole schema source. */
const GROUPS = Object.freeze(['CN-POWER-MCP','CN-M365-MCP','CN-DEV-MCP','CN-CLOUD-MCP','CN-AI-MCP']);
function classify(name) {
  if (/powerapps|power_automate|powerautomate|sharepoint|dataverse|employee_ledger|platform|flow_|user_info|passkey/.test(name)) return GROUPS[0];
  if (/outlook|teams|calendar|onedrive|people|m365/.test(name)) return GROUPS[1];
  if (/github|git_|source|ci_|branch/.test(name)) return GROUPS[2];
  if (/azure|deploy|deployment|kudu|rollback_deployment/.test(name)) return GROUPS[3];
  if (/agent|execution|evidence|capture_|runtime|done|playbook|reuse|prohibited|executive|task|checkpoint/.test(name)) return GROUPS[4];
  return null; // unmapped capability must be reviewed
}
function operation(name) {
  if (/^(publish_|.*_publish$)|publish_verify|app_edit_publish/.test(name)) return 'PUBLISH';
  if (/^(delete_|remove_)|_delete$/.test(name)) return 'DELETE';
  if (/^(run_|execute_|deploy_|rollback_|restore_|capture_|create_execution_request)|^validate_powerapps_change$|^verify_save_result$|^run_powerapps_tests$|^compare_powerapps_with_git$|^validate_powerapps_source$/.test(name)) return 'EXECUTE';
  if (/^(get_|list_|health_|check_|inspect_|discover_|compare_|validate_|verify_|export_|suggest_|assess_|can_|generate_runtime_report$|powerapps_app_read$)/.test(name)) return 'READ';
  return 'WRITE'; // unknown tools never default to READ
}
function buildRegistry(tools) {
  if (!Array.isArray(tools)) throw new TypeError('tool definitions required');
  const names = new Set();
  return tools.map(tool => {
    if (!tool || typeof tool.name !== 'string' || names.has(tool.name)) throw new Error('invalid or duplicate tool');
    names.add(tool.name);
    const action = operation(tool.name);
    const mcp = classify(tool.name);
    return Object.freeze({name:tool.name, mcp, action,
      classified: Boolean(mcp), requiresAuth:true, requiresPermission:true,
      requiresApproval:action !== 'READ', audit:true,
      inputSchema:tool.inputSchema});
  });
}
function route(registry, name, args, context, handlers) {
  const capability = registry.find(x => x.name === name);
  if (!capability || !capability.classified) return {status:'BLOCKED',reason:'unknown_or_unclassified_capability'};
  if (!context || context.authenticated !== true || context.permitted !== true)
    return {status:'BLOCKED',reason:'auth_or_permission_unverified'};
  if (capability.requiresApproval && context.humanApprovalVerified !== true)
    return {status:'BLOCKED',reason:'human_approval_unverified'};
  if (!context.auditReady || !context.policyVerified || !context.targetVerified)
    return {status:'BLOCKED',reason:'policy_target_or_audit_unverified'};
  if (!handlers || typeof handlers[name] !== 'function')
    return {status:'BLOCKED',reason:'handler_not_registered'};
  return handlers[name](args, context); // caller owns existing verification/audit; no fake PASS
}
module.exports = {GROUPS,classify,operation,buildRegistry,route};
