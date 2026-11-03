'use strict';
// In-memory isolated test ledger. No delivery, execution, or persistent storage.
function createHandoffLedger() {
 const records=new Map();
 function accept(handoff) {
  if (!handoff || handoff.status!=='READY_FOR_VERIFIED_TRANSPORT' || !handoff.payload || !/^[a-f0-9]{64}$/.test(handoff.digest||'')) throw new Error('invalid_handoff');
  const id=handoff.payload.requestId;
  if (typeof id!=='string' || handoff.payload.executionAllowed!==false || handoff.payload.requiresHumanApproval!==true) throw new Error('unsafe_handoff');
  const previous=records.get(id);
  if (previous) return Object.freeze({status:previous.digest===handoff.digest?'DUPLICATE':'CONFLICT',requestId:id,delivered:false});
  records.set(id,Object.freeze({digest:handoff.digest,status:'PENDING_VERIFIED_TRANSPORT'}));
  return Object.freeze({status:'PENDING_VERIFIED_TRANSPORT',requestId:id,delivered:false});
 }
 function status(id) {return records.get(id)?.status||'NOT_FOUND';}
 return Object.freeze({accept,status});
}
module.exports={createHandoffLedger};
