'use strict';

const { initialState, currentStep, advance, resume } = require('./cnaiAutoPipeline');
const { planRecovery, recoveryVerified } = require('./cnaiRecoveryEngine');
const { chooseRecovery, preflight } = require('./cnaiAdaptiveIntelligence');
const { planExecution, evaluateCompletion } = require('./cnaiStrategicOrchestrator');
const { getCnaiVersion } = require('./cnaiVersion');

// This facade combines planning and recovery without granting authority to
// execute external side effects. State persistence and tool execution remain
// the responsibility of the authenticated Bridge worker.
function createExecutionPlan({ id, goal, tasks, completed = [] }) {
  const state = initialState(id);
  const execution = planExecution(goal, tasks, completed);
  return { version: getCnaiVersion().version, state, execution,
    nextStep: currentStep(state), automaticExecutionEnabled: false };
}

function assessFailure({ state, failure, candidates = [], history = [] }) {
  const recovery = planRecovery(state, failure);
  if (recovery.status !== 'RECOVERING')
    return { recovery, decision: null };
  const decision = chooseRecovery(candidates, history);
  return { recovery, decision };
}

function verifyPreflight(checks) { return preflight(checks); }
function checkDone(requiredEvidence, observedEvidence) {
  return evaluateCompletion(requiredEvidence, observedEvidence);
}

module.exports = {
  createExecutionPlan, assessFailure, verifyPreflight, checkDone,
  advance, resume, recoveryVerified
};
