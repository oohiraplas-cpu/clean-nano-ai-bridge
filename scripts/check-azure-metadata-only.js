'use strict';
// Azure control-plane metadata only. Never request app settings, credentials,
// tokens, role assignments or PAC profiles. No deployment SHA inference.
const { execFileSync } = require('node:child_process');
const { assessAzureReadiness } = require('../src/azureReadiness');
const { sanitizeMetadataFailures, metadataFailure } = require('../src/azureMetadataFailures');
function collect({ runCli = execFileSync } = {}) {
  const failures = [];
  const az = (stage, args) => {
    let output;
    try {
      output = runCli('az', [...args, '--only-show-errors', '--output', 'json'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000
      });
    } catch (error) {
      // Only structured process codes are classified. Never expose stderr/messages
      // or guess authentication/permission failures from arbitrary CLI text.
      const reason = error?.code === 'ENOENT' ? 'cli_missing'
        : error?.code === 'ETIMEDOUT' ? 'timeout'
        : Number.isInteger(error?.status) && error.status !== 0 ? 'cli_exit_nonzero'
        : 'cli_execution_failed';
      throw metadataFailure(stage, reason);
    }
    try { return JSON.parse(output); }
    catch { throw metadataFailure(stage, 'malformed_json'); }
  };
  const apps = az('target_lookup', ['webapp', 'list', '--query',
    "[?name=='clean-nano-ai-bridge'].{name:name,id:id,resourceGroup:resourceGroup,state:state}"]);
  if (!Array.isArray(apps)) throw metadataFailure('target_lookup', 'invalid_response');
  if (apps.length !== 1) throw metadataFailure('target_lookup', 'target_not_unique');
  const app = apps[0];
  const expected = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge$/i;
  if (!app || typeof app !== 'object' || typeof app.id !== 'string' || !expected.test(app.id) ||
      app.name !== 'clean-nano-ai-bridge' || typeof app.resourceGroup !== 'string' ||
      app.id.split('/')[4].toLowerCase() !== app.resourceGroup.toLowerCase()) {
    throw metadataFailure('target_lookup', 'resource_id_mismatch');
  }
  const args = ['--name', app.name, '--resource-group', app.resourceGroup];
  let managedIdentityAssigned = false;
  try {
    const identity = az('identity_lookup', ['webapp', 'identity', 'show', ...args, '--query', '{type:type,principalId:principalId}']);
    managedIdentityAssigned = /^(SystemAssigned|SystemAssigned, UserAssigned)$/.test(identity?.type || '')
      && /^[a-f0-9-]{36}$/i.test(identity?.principalId || '');
    if (!managedIdentityAssigned) failures.push({ stage: 'identity_lookup', reason: 'identity_unverified' });
  } catch (error) { failures.push(...sanitizeMetadataFailures(error.metadataFailures)); }
  let deploymentMetadataAccessible = false;
  let deploymentEntries = [];
  try {
    const deployments = az('deployment_history', ['webapp', 'log', 'deployment', 'list', ...args,
      '--query', '[].{deploymentId:id,active:active,status:status,receivedTime:received_time}']);
    if (!Array.isArray(deployments) || deployments.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw metadataFailure('deployment_history', 'invalid_response');
    }
    deploymentMetadataAccessible = true;
    if (deploymentMetadataAccessible) deploymentEntries = deployments.map(entry => ({
      deploymentId: typeof entry.deploymentId === 'string' ? entry.deploymentId.slice(0, 100) : null,
      active: entry.active === true,
      status: Number.isInteger(entry.status) ? entry.status : null,
      receivedTime: typeof entry.receivedTime === 'string' ? entry.receivedTime.slice(0, 40) : null
    }));
  } catch (error) { failures.push(...sanitizeMetadataFailures(error.metadataFailures)); }
  const readiness = assessAzureReadiness({
    resourceIdMatched: true, managedIdentityAssigned,
    deploymentShaMatched: false, rbacReadVerified: false,
    runtimeKeysPresent: false, pacProfileVerified: false,
    sourceMapVerified: false, healthVerified: false
  });
  return Object.freeze({ resourceIdMatched: true,
    armResourceId: app.id, armObservedIndependently: true,
    managedIdentityAssigned, managedIdentityObservedIndependently: managedIdentityAssigned,
    deploymentMetadataAccessible, deploymentEntries, deploymentShaMatched: false,
    effectiveRbacVerified: false, pacRuntimeVerified: false, readiness,
    metadataFailures: sanitizeMetadataFailures(failures) });
}
if (require.main === module) {
  try { console.log(JSON.stringify(collect())); }
  catch (error) {
    console.error(JSON.stringify({ status: 'blocked', reason: 'azure_metadata_unavailable_or_unverified',
      metadataFailures: sanitizeMetadataFailures(error.metadataFailures) }));
    process.exitCode = 1;
  }
}
module.exports = { collect };
