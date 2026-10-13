'use strict';

// Read-only media bridge contract. A trusted Power Apps runtime adapter must
// be injected by server configuration; no guessed Power Platform endpoints.
const OPS = Object.freeze(['list_powerapps_media_assets', 'get_powerapps_media_asset', 'export_powerapps_asset']);
function createPowerAppsMediaTools({ adapter, appId, environmentId } = {}) {
  return async function execute(method, params = {}) {
    const blocked = reason => ({ status: 'BLOCKED', reason, sideEffects: false });
    if (!OPS.includes(method)) return blocked('unknown_media_operation');
    if (!appId || !environmentId || !adapter ||
        !OPS.every(op => typeof adapter[op] === 'function')) return blocked('media_adapter_not_configured');
    if (!params || typeof params !== 'object' || Array.isArray(params) ||
        Object.keys(params).some(key => !['assetId'].includes(key))) return blocked('invalid_media_request');
    if (method !== 'list_powerapps_media_assets' &&
        (typeof params.assetId !== 'string' || !/^[\w.-]{1,200}$/.test(params.assetId))) {
      return blocked('asset_id_required');
    }
    try {
      const result = await adapter[method]({ appId, environmentId, ...(method === 'list_powerapps_media_assets' ? {} : { assetId: params.assetId }) });
      if (!result || result.success !== true) return blocked('media_read_unverified');
      return { status: 'VERIFIED', operation: method, data: result.data, sideEffects: false };
    } catch {
      return blocked('media_read_failed');
    }
  };
}
module.exports = { OPS, createPowerAppsMediaTools };
