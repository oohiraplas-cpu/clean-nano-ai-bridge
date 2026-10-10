'use strict';

const { currentStep } = require('./cnaiAutoPipeline');
const { executeStep } = require('./cnaiBridgeExecutor');
const { planRecovery } = require('./cnaiRecoveryEngine');

// Single-iteration driver. Callers must schedule subsequent iterations
// and persist checkpoints. Adapter failures are classified for recovery,
// not silently retried or converted to success.
async function runIteration({ worker, id, authority, adapters, classifyError }) {
  if (!worker || typeof worker.status !== 'function' ||
      typeof worker.verifyAndAdvance !== 'function' ||
      typeof worker.recordFailure !== 'function')
    throw new Error('checkpoint worker required');
  const state = await worker.status(id);
  if (!state) return { status: 'NOT_FOUND' };
  if (state.status !== 'READY') return { status: state.status, state };
  const step = currentStep(state);
  if (!step) return { status: 'DONE', state };
  if (step === 'PUBLISH_APPROVAL')
    return { status: 'WAITING_APPROVAL', step };
  let result;
  try {
    result = await executeStep({ step, authority, adapters });
  } catch (error) {
    const failure = typeof classifyError === 'function'
      ? classifyError(error, step) : { code: 'UNKNOWN_FAILURE' };
    const recovery = await worker.recordFailure(id, failure);
    return { status: recovery.status, step, recovery };
  }
  if (result.status === 'VERIFIED') {
    const advanced = await worker.verifyAndAdvance(id, {
      step, success: true, evidenceId: result.evidenceId
    }, { authorized: authority && authority.humanAuthorizationVerified === true });
    return { status: advanced.state.status, step, nextStep: advanced.nextStep };
  }
  if (result.status === 'NEEDS_RECOVERY') {
    const recovery = await worker.recordFailure(id, {
      code: 'VERIFICATION_FAILED', signature: step
    });
    return { status: recovery.status, step, recovery };
  }
  return { status: result.status, step, reason: result.reason };
}
module.exports = { runIteration };
