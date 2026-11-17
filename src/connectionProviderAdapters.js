'use strict';
// Provider-neutral read-only adapter. Credentials stay in the provider's
// managed identity/OAuth connection; no tokens, URLs with signatures or keys
// are accepted in the public diagnosis result.
const { diagnoseConnection } = require('./connectionRepairDiagnostic');
const SERVICES = new Set(['azure','azureAi','powerApps','powerAutomate','copilotStudio']);
function createReadOnlyProviderAdapter(service, provider, {timeoutMs=10000}={}) {
  if (!SERVICES.has(service) || !provider || typeof provider.probe !== 'function') {
    throw new TypeError('unsupported_provider');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new TypeError('invalid_probe_timeout');
  return Object.freeze({
    async diagnose() {
      let response;
      let timer;
      try {
        response = await Promise.race([
          Promise.resolve().then(()=>provider.probe()),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),timeoutMs);})
        ]);
      } catch { return { status:'BLOCKED',reason:'provider_probe_failed',verified:false }; }
      finally { clearTimeout(timer); }
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
