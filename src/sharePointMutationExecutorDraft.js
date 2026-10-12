'use strict';
const {changeHash, verifyApproval} = require('./sharePointMutationContractDraft');

// Draft-only orchestration. All security dependencies are server-owned.
// No route/MCP registration: no production writes are exposed.
function createSharePointMutationExecutor(deps = {}) {
  const required = ['loadApproval','verifyHuman','reserveETag','readReservation','readRuntimeSha','backup','recheck','writer','readback','audit'];
  return async function execute(plan, approvalId) {
    const blocked = reason => ({status:'BLOCKED',reason});
    if (required.some(key => !deps[key] || (key !== 'writer' && typeof deps[key] !== 'function'))) return blocked('dependency_not_configured');
    let reserved = false;
    try {
      const digest = changeHash(plan);
      if (typeof approvalId !== 'string' || !/^[1-9][0-9]*$/.test(approvalId)) return blocked('invalid_approval_id');
      const currentSha = await deps.readRuntimeSha();
      if (currentSha !== plan.runtimeCommitSha) return blocked('runtime_sha_mismatch');
      const snapshot = await deps.loadApproval(approvalId);
      verifyApproval(plan,snapshot?.record);
      if (!snapshot?.etag || snapshot.etag === '*' || await deps.verifyHuman(snapshot) !== true) return blocked('human_or_etag_unverified');
      const backup = await deps.backup(plan);
      if (!backup || backup.verified !== true || !backup.reference) return blocked('backup_unverified');
      const receipt = await deps.reserveETag(approvalId,snapshot.etag,{changeHash:digest,operation:plan.operation,plan});
      if (!receipt?.executionId || receipt?.reserved !== true) return blocked('reservation_failed');
      reserved = true;
      const confirmed = await deps.readReservation(approvalId);
      if (!confirmed || confirmed.executionId !== receipt.executionId || confirmed.changeHash !== digest || confirmed.status !== 'reserved' || !confirmed.etag || confirmed.etag === snapshot.etag) return blocked('reservation_unconfirmed');
      if (await deps.verifyHuman(snapshot) !== true || await deps.recheck({plan,approvalId,receipt,snapshot,confirmed}) !== true) return blocked('approval_recheck_failed');
      // A single trusted writer executes only the approved operation.
      if (await deps.readRuntimeSha() !== plan.runtimeCommitSha) return blocked('runtime_sha_changed');
      const writer = deps.writer;
      const p = plan.params;
      let result;
      switch(plan.operation) {
        case 'create_list': result = await writer.createList(plan.siteId,p.displayName,p.template); break;
        case 'create_column': result = await writer.createColumn(plan.siteId,plan.listId,p.columnDefinition); break;
        case 'create_item': result = await writer.createItemFields(plan.siteId,plan.listId,p.fields); break;
        case 'update_item': result = await writer.updateItemFields(plan.siteId,plan.listId,plan.itemId,p.fields); break;
        default: return blocked('unsupported_operation');
      }
      const verified = await deps.readback({plan,result,backup});
      if (verified !== true) return blocked('post_write_verification_failed');
      await deps.audit({approvalId,executionId:receipt.executionId,changeHash:digest,backupReference:backup.reference,status:'VERIFIED'});
      return {status:'VERIFIED',executionId:receipt.executionId,backupReference:backup.reference};
    } catch (error) {
      // A write may have occurred: never automatically retry or claim rollback.
      return blocked(reserved ? 'mutation_or_verification_failed_after_reservation' : 'preflight_or_reservation_failed');
    }
  };
}
module.exports = {createSharePointMutationExecutor};
