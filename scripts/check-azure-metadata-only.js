'use strict';
// Azure control-plane metadata only. Never request app settings, credentials,
// tokens, role assignments or PAC profiles. No deployment SHA inference.
const { execFileSync } = require('node:child_process');
const { assessAzureReadiness } = require('../src/azureReadiness');
const az = args => JSON.parse(execFileSync('az', [...args, '--only-show-errors', '--output', 'json'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000
}));
function collect() {
  const apps = az(['webapp', 'list', '--query',
    "[?name=='clean-nano-ai-bridge'].{name:name,id:id,resourceGroup:resourceGroup,state:state}"]);
  if (!Array.isArray(apps) || apps.length !== 1) throw new Error('azure_target_unverified');
  const app = apps[0];
  const expected = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge$/i;
  if (!expected.test(app.id || '')) throw new Error('azure_resource_id_unverified');
  const args = ['--name', app.name, '--resource-group', app.resourceGroup];
  let managedIdentityAssigned = false;
  try {
    const identity = az(['webapp', 'identity', 'show', ...args, '--query', '{type:type,principalId:principalId}']);
    managedIdentityAssigned = /^(SystemAssigned|SystemAssigned, UserAssigned)$/.test(identity?.type || '')
      && /^[a-f0-9-]{36}$/i.test(identity?.principalId || '');
  } catch { /* unverified */ }
  let deploymentMetadataAccessible = false;
  let deploymentEntries = [];
  try {
    const deployments = az(['webapp', 'log', 'deployment', 'list', ...args,
      '--query', '[].{deploymentId:id,active:active,status:status,receivedTime:received_time}']);
    deploymentMetadataAccessible = Array.isArray(deployments);
    if (deploymentMetadataAccessible) deploymentEntries = deployments.map(entry => ({
      deploymentId: typeof entry.deploymentId === 'string' ? entry.deploymentId.slice(0, 100) : null,
      active: entry.active === true,
      status: Number.isInteger(entry.status) ? entry.status : null,
      receivedTime: typeof entry.receivedTime === 'string' ? entry.receivedTime.slice(0, 40) : null
    }));
  } catch { /* unverified */ }
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
    effectiveRbacVerified: false, pacRuntimeVerified: false, readiness });
}
if (require.main === module) {
  try { console.log(JSON.stringify(collect())); }
  catch { console.error('azure_metadata_unavailable_or_unverified'); process.exitCode = 1; }
}
module.exports = { collect };
