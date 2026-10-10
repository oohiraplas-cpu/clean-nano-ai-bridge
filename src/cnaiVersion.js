'use strict';

const CNAI_VERSION = '6.0.0-beta.1';
const CNAI_RELEASE_CHANNEL = 'beta';
const CAPABILITIES = Object.freeze({
  gatedPipeline: 'implemented-planning',
  boundedRecovery: 'implemented-planning',
  adaptiveDecision: 'implemented-planning',
  dependencyOrchestration: 'implemented-planning',
  bridgePlanningApi: 'implemented',
  autonomousExecutionWorker: 'not-implemented',
  durableCheckpointStore: 'not-implemented',
  azureDeploymentAutomation: 'not-implemented',
  powerAppsRuntimeIntegration: 'not-implemented',
  productionRelease: 'not-deployed'
});
function getCnaiVersion() {
  return {
    name: 'CNAI Strategic Autonomy',
    version: CNAI_VERSION,
    channel: CNAI_RELEASE_CHANNEL,
    bridgePackageVersionUnchanged: true,
    capabilities: { ...CAPABILITIES },
    productionReady: false
  };
}
module.exports = { CNAI_VERSION, CNAI_RELEASE_CHANNEL, CAPABILITIES, getCnaiVersion };
