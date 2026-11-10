'use strict';

// Authenticated Microsoft provider transport boundary.
// Endpoint URLs must be verified and supplied by the operator's configuration;
// no guessed API route, implicit credential, or write capability is enabled.
const { ENVIRONMENT_ID, AGENT_ID } = require('./copilotStudioAdapter');
const blocked = reasonCode => ({ status: 'BLOCKED', reasonCode, executed: false });
function createCopilotStudioProvider({ read, endpoints, authorization } = {}) {
  async function inspect({ environmentId, agentId }) {
    if (environmentId !== ENVIRONMENT_ID || agentId !== AGENT_ID) return blocked('TARGET_MISMATCH');
    if (typeof read !== 'function') return blocked('MICROSOFT_READ_TRANSPORT_MISSING');
    if (typeof authorization !== 'function') return blocked('MICROSOFT_AUTH_PROVIDER_MISSING');
    const endpoint = endpoints && endpoints.inspect;
    if (typeof endpoint !== 'string' || !/^https:\/\//i.test(endpoint)) return blocked('VERIFIED_ENDPOINT_REQUIRED');
    const token = await authorization();
    if (!token || typeof token !== 'string') return blocked('MICROSOFT_AUTH_REQUIRED');
    try {
      const result = await read({ url: endpoint, method: 'GET', token, environmentId, agentId });
      if (!result || typeof result !== 'object' || Array.isArray(result)) return blocked('INVALID_PROVIDER_RESPONSE');
      return result;
    } catch {
      return blocked('MICROSOFT_READ_FAILED');
    }
  }
  return Object.freeze({ inspect });
}
module.exports = { createCopilotStudioProvider };
