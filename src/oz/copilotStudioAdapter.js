'use strict';

// Copilot Studio management adapter boundary. No browser cookies, secrets,
// connector tokens, or caller-supplied approval flags are accepted here.
// A Microsoft-authorized provider must be injected after permission/licensing review.
const ENVIRONMENT_ID = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const AGENT_ID = '1a93deb5-a45c-4572-9df3-96d6fc166d6b';
const ACTIONS = Object.freeze(['inspect', 'snapshot', 'propose', 'applyDraft', 'verify']);
const blocked = (reasonCode) => ({ status: 'BLOCKED', reasonCode, executed: false });

function createCopilotStudioAdapter(provider = null) {
  async function invoke(action, request = {}, context = {}) {
    if (!ACTIONS.includes(action)) return blocked('UNSUPPORTED_ACTION');
    if (!request || typeof request !== 'object' || Array.isArray(request)) return blocked('INVALID_INPUT');
    if (request.environmentId && request.environmentId !== ENVIRONMENT_ID) return blocked('TARGET_MISMATCH');
    if (request.agentId && request.agentId !== AGENT_ID) return blocked('TARGET_MISMATCH');
    if (context.authenticated !== true) return blocked('AUTH_REQUIRED');
    if (!provider || typeof provider[action] !== 'function') return blocked('MICROSOFT_PROVIDER_NOT_CONNECTED');
    if (action === 'applyDraft') {
      if (context.permissionVerified !== true) return blocked('PERMISSION_NOT_VERIFIED');
      if (context.licenseVerified !== true) return blocked('LICENSE_NOT_VERIFIED');
      if (context.snapshotVerified !== true) return blocked('SNAPSHOT_REQUIRED');
      if (context.dryRunVerified !== true) return blocked('DRY_RUN_REQUIRED');
      if (context.productionChangeApproved !== true) return blocked('PRODUCTION_APPROVAL_REQUIRED');
    }
    try {
      const result = await provider[action]({ environmentId: ENVIRONMENT_ID, agentId: AGENT_ID, request });
      return result && typeof result === 'object' ? result : blocked('INVALID_PROVIDER_RESPONSE');
    } catch {
      return blocked('PROVIDER_ERROR');
    }
  }
  return Object.freeze({ invoke, actions: ACTIONS, environmentId: ENVIRONMENT_ID, agentId: AGENT_ID });
}

module.exports = { createCopilotStudioAdapter, ENVIRONMENT_ID, AGENT_ID };
