'use strict';
const {createSharePointApprovalReservation}=require('./sharePointApprovalReservationDraft');
const {createSharePointMutationExecutor}=require('./sharePointMutationExecutorDraft');
const {createSharePointReadback}=require('./sharePointReadbackDraft');
// Server-only composition. No public route, and no default identity/backup provider.
// The reservation gate owns the approval read/If-Match/recheck lifecycle.
function createGuardedSharePointExecutor({store,writer,readRuntimeSha,backup,audit}={}) {
  const gate=createSharePointApprovalReservation({store});
  const loadApproval=id=>store.read(id);
  return createSharePointMutationExecutor({
    loadApproval,
    verifyHuman:s=>store.verifyHuman(s),
    reserveETag:async(id,_etag,{plan})=>gate.reserve(id,plan),
    readReservation:async id=>{
      const snapshot=await store.read(id);
      return {etag:snapshot.etag,executionId:snapshot.record.executionId,
        changeHash:snapshot.record.changeHash,status:snapshot.record.executionStatus};
    },
    recheck:async({approvalId,plan,receipt})=>gate.recheck(approvalId,plan,receipt.executionId),
    readRuntimeSha,backup,audit,writer,readback:createSharePointReadback(writer)
  });
}
module.exports={createGuardedSharePointExecutor};
