'use strict';
const {authorizeExecution} = require('./approvedExecutionGateDraft');
// Explicit integration boundary. Production mutation cannot be enabled by this
// Draft entrypoint; a separately reviewed deployment path is required.
const draftOperations = Object.freeze({
  ci_verify: 'getCiEvidence',
  draft_edit: 'applyDraftChange'
});
async function executeApprovedDraft({plan, adapter, evidence}) {
  const gate = await authorizeExecution({plan});
  if (gate.status !== 'PASS' || gate.scope !== 'draft_only') return {status:'BLOCKED',reason:gate.reason || 'production_execution_disabled'};
  const method = draftOperations[plan.operation];
  if (!method || !adapter || typeof adapter[method] !== 'function') return {status:'BLOCKED',reason:'real_api_adapter_not_configured'};
  try {
    const result = await adapter[method]({plan,planHash:gate.planHash,evidence});
    if (!result || result.verified !== true || result.planHash !== gate.planHash ||
        typeof result.evidenceId !== 'string' || !result.evidenceId.trim()) return {status:'BLOCKED',reason:'independent_api_evidence_missing'};
    return {status:'PASS',operation:plan.operation,evidenceId:result.evidenceId,planHash:gate.planHash};
  } catch { return {status:'BLOCKED',reason:'api_execution_failed'}; }
}
module.exports = {executeApprovedDraft};
