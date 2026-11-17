'use strict';
// Provider-neutral read-only adapter. Credentials stay in the provider's
// managed identity/OAuth connection; no tokens, URLs with signatures or keys
// are accepted in the public diagnosis result.
const { diagnoseConnection } = require('./connectionRepairDiagnostic');
const SERVICES = new Set(['azure','azureAi','powerApps','powerAutomate','copilotStudio']);
function createReadOnlyProviderAdapter(service, provider) {
  if (!SERVICES.has(service) || !provider || typeof provider.probe !== 'function') {
    throw new TypeError('unsupported_provider');
  }
  return Object.freeze({
    async diagnose() {
      let response;
      try { response = await provider.probe(); }
      catch { return { status:'BLOCKED',reason:'provider_probe_failed',verified:false }; }
      if (!response || !Number.isInteger(response.status) ||
          typeof response.configured !== 'boolean') {
        return {status:'BLOCKED',reason:'unverified_provider_response',verified:false};
      }
      const diagnosis=diagnoseConnection({service,status:response.status,configured:response.configured});
      const verified=diagnosis.status==='PASS' && response.authorizedOperationVerified===true;
      return {status:diagnosis.status==='PASS' && !verified ? 'PARTIAL' : diagnosis.status,
        reason:diagnosis.status==='PASS' && !verified ? 'authorized_operation_unverified' : diagnosis.reason,
        verified,
        nextAction:diagnosis.nextAction};
    }
  });
}
module.exports={createReadOnlyProviderAdapter};
