'use strict';
const {changeHash,verifyApproval}=require('./sharePointMutationContractDraft');
// Server-owned callbacks only. Never accept identity or approval assertions from MCP input.
function createSharePointApprovalRecheck({readApproval,verifyHuman,now=()=>Date.now()}={}) {
  return async ({plan,approvalId,receipt,snapshot,confirmed}={})=>{
    if(typeof readApproval!=='function'||typeof verifyHuman!=='function'||!plan||
       !receipt?.executionId||!snapshot?.etag||!confirmed?.etag||
       confirmed.etag===snapshot.etag) return false;
    try {
      const hash=changeHash(plan);
      const current=await readApproval(approvalId);
      const record=current?.record;
      if(!record||current.etag!==confirmed.etag||record.executionId!==receipt.executionId||
         record.executionStatus!=='reserved'||record.changeHash!==hash||
         record.revoked!==false||record.status!=='APPROVED') return false;
      const decision={...record};
      delete decision.executionId;
      delete decision.executionStatus;
      verifyApproval(plan,decision);
      const approved=Date.parse(record.approvedAt),expires=Date.parse(record.expiresAt),time=now();
      if(!Number.isFinite(approved)||!Number.isFinite(expires)||approved>time||
         expires<=time||expires-approved>86400000||
         record.approver!==snapshot.record?.approver||
         record.approvedAt!==snapshot.record?.approvedAt||
         record.changeHash!==snapshot.record?.changeHash) return false;
      if(await verifyHuman({original:snapshot,current})!==true) return false;
      const final=await readApproval(approvalId);
      return Boolean(final?.etag===current.etag&&
        final.record?.executionId===receipt.executionId&&
        final.record?.executionStatus==='reserved'&&
        final.record?.revoked===false&&final.record?.status==='APPROVED'&&
        final.record?.changeHash===hash&&Date.parse(final.record?.expiresAt)>now());
    }catch{return false;}
  };
}
module.exports={createSharePointApprovalRecheck};
