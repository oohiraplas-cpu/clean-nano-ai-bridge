'use strict';
// The existing saveApp() only records a state snapshot. Do not call it as a save primitive.
// This adapter refuses to claim a save without a separately implemented and verified writer.
async function requireVerifiedCanvasSave({ saveWriter, verifySavedVersion, appId, environmentId, expectedVersion } = {}) {
  if (!appId || !environmentId || !expectedVersion || typeof saveWriter !== 'function' ||
      typeof verifySavedVersion !== 'function') {
    return Object.freeze({ status:'BLOCKED', reason:'verified_save_adapter_not_configured' });
  }
  // Intentionally no mutation: writer contract is not validated against a supported API yet.
  return Object.freeze({ status:'BLOCKED', reason:'canvas_save_api_contract_unverified' });
}
module.exports = { requireVerifiedCanvasSave };
