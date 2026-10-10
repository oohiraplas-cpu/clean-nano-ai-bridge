'use strict';

// Pure, fail-closed state machine. The caller must verify evidence independently
// and persist the returned state before invoking any external side effect.
const STEPS = Object.freeze([
  'PR_COMPLETE', 'CI_SUCCESS', 'AZURE_DEPLOY', 'PRODUCTION_E2E',
  'THREE_SCREENS', 'S12_EDIT', 'SAVE', 'READ_BACK', 'PUBLISH_APPROVAL'
]);
const MUTATING = new Set(['AZURE_DEPLOY', 'S12_EDIT', 'SAVE']);
const TERMINAL = new Set(['DONE', 'BLOCKED']);

function initialState(id) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('pipeline id required');
  return { id, index: 0, status: 'READY', evidence: {}, history: [] };
}
function currentStep(state) {
  return state.index < STEPS.length ? STEPS[state.index] : null;
}
function advance(state, proof, options = {}) {
  if (!state || !Array.isArray(state.history) || TERMINAL.has(state.status))
    throw new Error('pipeline not runnable');
  const step = currentStep(state);
  if (!step) return { ...state, status: 'DONE' };
  if (!proof || proof.step !== step || proof.success !== true ||
      typeof proof.evidenceId !== 'string' || !proof.evidenceId.trim())
    return { ...state, status: 'BLOCKED', blockedAt: step, reason: 'VERIFIED_EVIDENCE_REQUIRED' };
  if (MUTATING.has(step) && options.authorized !== true)
    return { ...state, status: 'BLOCKED', blockedAt: step, reason: 'EXPLICIT_AUTHORIZATION_REQUIRED' };
  if (step === 'PUBLISH_APPROVAL' && options.humanApproved !== true)
    return { ...state, status: 'WAITING_APPROVAL', blockedAt: step, reason: 'HUMAN_APPROVAL_REQUIRED' };
  const index = state.index + 1;
  return {
    ...state, index, status: index === STEPS.length ? 'DONE' : 'READY',
    blockedAt: undefined, reason: undefined,
    evidence: { ...state.evidence, [step]: proof.evidenceId },
    history: [...state.history, { step, evidenceId: proof.evidenceId }]
  };
}
function resume(state, options = {}) {
  if (!state || !['BLOCKED', 'WAITING_APPROVAL'].includes(state.status))
    throw new Error('pipeline not paused');
  if (options.resumeAuthorized !== true) throw new Error('resume authorization required');
  return { ...state, status: 'READY', blockedAt: undefined, reason: undefined };
}
module.exports = { STEPS, initialState, currentStep, advance, resume };
