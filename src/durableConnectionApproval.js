'use strict';
// Durable approval contract: the caller supplies an authenticated principal and
// a transactional store with compare-and-swap. No in-memory grant is trusted.
// Store must persist only request metadata, never credentials or access tokens.
const ALLOWED_ACTIONS = new Set(['rotate_credential','change_permissions','change_production_settings','revoke_credential']);
function createDurableApprovalService(store) {
  if (!store || typeof store.get !== 'function' || typeof store.compareAndSwap !== 'function') {
    throw new TypeError('transactional_store_required');
  }
  async function consume({requestId,subjectId,utterance,targetId}={}) {
    if (utterance!=='承認する' || !requestId || !subjectId || !targetId)
      return {status:'HUMAN_APPROVAL_REQUIRED',reason:'explicit_approval_required'};
    let record;
    try {record=await store.get(requestId);} catch {return {status:'BLOCKED',reason:'approval_store_unavailable'};}
    if (!record || record.source!=='trusted_server' || record.status!=='pending' ||
      record.presentedToUser!==true || record.subjectId!==subjectId ||
      typeof record.targetId!=='string' || !record.targetId || record.targetId!==targetId ||
      typeof record.service!=='string' || !record.service ||
      !ALLOWED_ACTIONS.has(record.action) ||
      !Number.isFinite(record.expiresAt) || record.expiresAt<=Date.now() ||
      typeof record.version!=='string' || !record.version)
      return {status:'BLOCKED',reason:'approval_invalid_or_expired'};
    let consumed=false;
    try { consumed=await store.compareAndSwap(requestId,record.version,'pending','consumed'); }
    catch {return {status:'BLOCKED',reason:'approval_store_unavailable'};}
    if (consumed!==true) return {status:'BLOCKED',reason:'approval_already_consumed'};
    return {status:'PARTIAL',reason:'approval_consumed_no_write',requestId,
      service:record.service,action:record.action,execution:'not_executed'};
  }
  return {consume};
}
module.exports={createDurableApprovalService};
