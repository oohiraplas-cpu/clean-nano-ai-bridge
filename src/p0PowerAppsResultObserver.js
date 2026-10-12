'use strict';
// Read-only Power Apps state observer. A current app version is not proof of a published version.
async function observePowerAppsResult({ store, expectedAppId, expectedEnvironmentId, expectedVersion } = {}) {
  if (!store || typeof store.getAppState !== 'function' || !expectedAppId || !expectedEnvironmentId || !expectedVersion) {
    return { operationConfirmed: false, reason: 'observer_not_configured' };
  }
  let state;
  try { state = await store.getAppState(); }
  catch { return { operationConfirmed: false, reason: 'app_state_unavailable' }; }
  if (!state || state.status !== 'ok' || state.appId !== expectedAppId || state.environmentId !== expectedEnvironmentId) {
    return { operationConfirmed: false, reason: 'app_target_mismatch' };
  }
  if (state.versionNumber !== expectedVersion) return { operationConfirmed: false, reason: 'app_version_mismatch' };
  // getAppState only reports draft/current version. It cannot attest to publish or a real save.
  return { operationConfirmed: false, observedVersion: state.versionNumber, reason: 'independent_publish_or_save_proof_unavailable' };
}
module.exports = { observePowerAppsResult };
