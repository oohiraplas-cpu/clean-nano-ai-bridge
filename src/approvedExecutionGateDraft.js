'use strict';
const crypto = require('node:crypto');
const SHA = /^[0-9a-f]{40}$/;
const allowedDraft = new Set(['draft_edit', 'ci_verify']);
const production = new Set(['main_merge', 'azure_config', 'deploy', 'powerapps_save', 'powerapps_publish']);
const all = new Set([...allowedDraft, ...production]);
function hashPlan(plan) {
  if (!plan || !all.has(plan.operation) || ![plan.requestId,plan.targetId,plan.environmentId].every(x => typeof x === 'string' && x.trim()) || !SHA.test(plan.headSha || '') || !SHA.test(plan.baseSha || '')) throw new Error('invalid_execution_plan');
  return crypto.createHash('sha256').update(JSON.stringify([plan.requestId,plan.operation,plan.targetId,plan.environmentId,plan.baseSha,plan.headSha])).digest('hex');
}
// No mutation is performed by this module. Caller must supply independently
// verified, single-use approval reservation and a fresh target SHA.
async function authorizeExecution({plan, approval, readHeadSha, reserveApproval, recheckApproval}) {
  let digest;
  try { digest = hashPlan(plan); } catch { return {status:'BLOCKED',reason:'invalid_execution_plan'}; }
  if (allowedDraft.has(plan.operation)) return {status:'PASS',scope:'draft_only',planHash:digest};
  if (!approval || approval.status !== 'approved' || approval.revoked !== false ||
      approval.planHash !== digest || approval.requestId !== plan.requestId ||
      approval.operation !== plan.operation || approval.targetId !== plan.targetId ||
      approval.environmentId !== plan.environmentId ||
      typeof readHeadSha !== 'function' || typeof reserveApproval !== 'function' ||
      typeof recheckApproval !== 'function') return {status:'BLOCKED',reason:'independent_approval_required'};
  try {
    if (await readHeadSha(plan) !== plan.headSha) return {status:'BLOCKED',reason:'head_sha_changed'};
    const reservation = await reserveApproval({plan,planHash:digest,approval});
    if (!reservation || reservation.reserved !== true || reservation.singleUseVerified !== true ||
        reservation.planHash !== digest || !reservation.executionId) return {status:'BLOCKED',reason:'reservation_failed'};
    if (await readHeadSha(plan) !== plan.headSha) return {status:'BLOCKED',reason:'head_sha_changed_after_reservation'};
    if (await recheckApproval({plan,planHash:digest,reservation}) !== true) return {status:'BLOCKED',reason:'approval_revoked'};
    return {status:'PASS',scope:'approved_single_use',planHash:digest,executionId:reservation.executionId};
  } catch { return {status:'BLOCKED',reason:'evidence_unavailable'}; }
}
module.exports = {hashPlan,authorizeExecution};
