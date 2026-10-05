/**
 * list_tools: 実在するツール・バージョン・実行可否を返す。実行可否は構成の有無のみで判定し、秘密値は返さない
 * （不足している環境変数の「名前」だけを返す）。外部APIへは接続しない（接続確認はhealth_check includeDependencies）。
 */
const { getBridgeCapabilities } = require('./bridgeCapabilities');

const GIT_TOOLS = ['get_powerapps_source', 'update_powerapps_app', 'save_powerapps_source', 'rollback_powerapps_change',
  'validate_powerapps_change', 'verify_save_result', 'compare_powerapps_with_git', 'validate_powerapps_source', 'run_powerapps_tests', 'list_git_branches'];
const APP_TOOLS = ['get_powerapps_app', 'get_powerapps_state', 'save_powerapps_app', 'publish_powerapps_app',
  'get_powerapps_operation_result', 'inspect_powerapps_structure', 'list_power_apps', 'list_environments', 'resolve_app_target', 'update_permissions', 'get_permissions'];
const AUDIT_TOOLS = ['get_powerapps_audit'];

function missing(pairs) {
  return pairs.filter(([, value]) => !value).map(([name]) => name);
}

function requirementsFor(name, config) {
  const pa = config.powerApps || {};
  const sp = config.sharepoint || {};
  const dep = config.deployment || {};
  const needs = [];
  if (APP_TOOLS.includes(name) || name === 'save_powerapps_source' || name === 'publish_powerapps_app') {
    needs.push(...missing([['POWERAPPS_TENANT_ID', pa.tenantId], ['POWERAPPS_CLIENT_ID', pa.clientId], ['POWERAPPS_CLIENT_SECRET', pa.clientSecret],
      ['POWERAPPS_ENVIRONMENT_ID', pa.environmentId], ['POWERAPPS_APP_ID', pa.appId]]));
  }
  if (GIT_TOOLS.includes(name) || name === 'publish_powerapps_app') {
    needs.push(...missing([['POWERAPPS_GITHUB_TOKEN', pa.githubToken], ['POWERAPPS_GITHUB_OWNER', pa.githubOwner], ['POWERAPPS_GITHUB_REPO', pa.githubRepo]]));
  }
  if (/sharepoint|employee_ledger/.test(name)) {
    needs.push(...missing([['SHAREPOINT_TENANT_ID', sp.tenantId], ['SHAREPOINT_CLIENT_ID', sp.clientId], ['SHAREPOINT_CLIENT_SECRET', sp.clientSecret], ['SHAREPOINT_SITE_ID', sp.siteId]]));
  }
  if (name === 'run_power_automate_flow' || name === 'list_registered_power_automate_flows') {
    needs.push(...missing([['POWER_AUTOMATE_FLOWS', Object.keys(config.powerAutomate?.flows || {}).length]]));
  }
  if (/deploy|deployment/.test(name) && !/validate/.test(name)) {
    needs.push(...missing([['DEPLOY_GITHUB_TOKEN', dep.githubToken], ['DEPLOY_GITHUB_OWNER', dep.githubOwner], ['DEPLOY_GITHUB_REPO', dep.githubRepo]]));
  }
  return [...new Set(needs)];
}

function listTools(publicTools, config, version) {
  const capabilities = getBridgeCapabilities(publicTools, { version }).data.tools.list;
  const byName = new Map(capabilities.map((tool) => [tool.name, tool]));
  const tools = publicTools.map((tool) => {
    const meta = byName.get(tool.name) || {};
    const missingConfiguration = requirementsFor(tool.name, config);
    const writes = !meta.readOnly && !AUDIT_TOOLS.includes(tool.name) && !/^(get_|list_|check_|resolve_|inspect_|compare_|export_|validate_|verify_)/.test(tool.name);
    return {
      name: tool.name,
      version,
      description: tool.description,
      executable: missingConfiguration.length === 0,
      missingConfiguration,
      readOnly: !writes,
      requiresApproval: Boolean(meta.requiresApproval) || ['save_powerapps_source', 'rollback_powerapps_change'].includes(tool.name)
    };
  });
  return { status: 'ok', version, count: tools.length, executableCount: tools.filter((t) => t.executable).length, tools };
}

module.exports = { listTools, requirementsFor };
