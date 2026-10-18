'use strict';

// Explicit server-side execution contract. The request body must never grant
// authority. Actual adapters are injected only by the authenticated Bridge.
const READ_ONLY_STEPS = new Set([
  'PR_COMPLETE', 'CI_SUCCESS', 'PRODUCTION_E2E', 'THREE_SCREENS', 'READ_BACK'
]);
const MUTATION_STEPS = new Set(['AZURE_DEPLOY', 'S12_EDIT', 'SAVE']);
const ALLOWED = new Set([...READ_ONLY_STEPS, ...MUTATION_STEPS]);

function verifyAuthority(step, authority) {
  if (!ALLOWED.has(step)) return { allowed: false, reason: 'UNSUPPORTED_STEP' };
  if (!authority || authority.targetLocked !== true ||
      authority.sourceObservationComplete !== true)
    return { allowed: false, reason: 'TARGET_OR_SOURCE_NOT_VERIFIED' };
  if (MUTATION_STEPS.has(step) &&
      (authority.humanAuthorizationVerified !== true ||
       authority.backupVerified !== true ||
       authority.rollbackAvailable !== true))
    return { allowed: false, reason: 'MUTATION_GATES_NOT_MET' };
  return { allowed: true, reason: null };
}

async function executeStep({ step, authority, adapters }) {
  const gate = verifyAuthority(step, authority);
  if (!gate.allowed) return { status: 'BLOCKED', step, reason: gate.reason };
  const adapter = adapters && adapters[step];
  if (typeof adapter !== 'function')
    return { status: 'NOT_CONFIGURED', step, reason: 'ADAPTER_MISSING' };
  const result = await adapter(Object.freeze({ ...authority }));
  if (!result || result.success !== true ||
      typeof result.evidenceId !== 'string' || !result.evidenceId.trim())
    return { status: 'NEEDS_RECOVERY', step, reason: 'VERIFICATION_FAILED' };
  return { status: 'VERIFIED', step, evidenceId: result.evidenceId };
}

module.exports = { READ_ONLY_STEPS, MUTATION_STEPS, verifyAuthority, executeStep };
