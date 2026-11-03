'use strict';
// Pure mapping to existing SharePoint column internal names; no writes or API calls.
const LISTS=Object.freeze({request:'973f17d6-3566-4795-9712-2386bb7bf540',audit:'32585e7f-200d-45da-a51a-3c68bc3b2394'});
function mapHandoffForReview(handoff) {
 if (!handoff || handoff.status!=='READY_FOR_VERIFIED_TRANSPORT' || handoff.payload?.executionAllowed!==false || handoff.payload?.requiresHumanApproval!==true || !/^[a-f0-9]{64}$/.test(handoff.digest||'')) throw new Error('handoff_not_verified');
 const p=handoff.payload;
 if (!p.requestId || !p.instruction) throw new Error('incomplete_handoff');
 return Object.freeze({listId:LISTS.request,fields:Object.freeze({
  Title:p.requestId,RequestContent:p.instruction,AIAnswer:'',
  AIAgent:'CNAI',AIAuditId:handoff.digest,
  _x627f__x8a8d__x72b6__x614b_:'承認待ち'
 }),writeAllowed:false,reason:'requires_external_acl_uniqueness_and_human_approval'});
}
module.exports={LISTS,mapHandoffForReview};
