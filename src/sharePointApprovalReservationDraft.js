'use strict';
const crypto=require('node:crypto');
const {changeHash,verifyApproval}=require('./sharePointMutationContractDraft');
// Draft-only: trusted store must implement read(id), patch(id, etag, fields),
// verifyHuman(snapshot), assertConfigured(). No public route is registered.
function createSharePointApprovalReservation({store,now=()=>Date.now()}={}) {
  const receipts=new Map();
  const validTag=v=>typeof v==='string'&&v.trim()!==''&&v!=='*';
  async function reserve(approvalId,plan,expectedETag) {
    try {
      if(!store||!['read','patch','verifyHuman','assertConfigured'].every(k=>typeof store[k]==='function')||
         !/^[1-9][0-9]*$/.test(String(approvalId))) return {reserved:false,reason:'not_configured'};
      store.assertConfigured();
      const hash=changeHash(plan),snapshot=await store.read(approvalId),record=snapshot?.record;
      verifyApproval(plan,record);
      const start=Date.parse(record.approvedAt),end=Date.parse(record.expiresAt),t=now();
      if(!validTag(snapshot.etag)||!validTag(expectedETag)||snapshot.etag!==expectedETag||record.executionId||record.executionStatus||
         record.revoked!==false||!Number.isFinite(start)||!Number.isFinite(end)||
         start>t||end<=t||end<=start||end-start>86400000||
         await store.verifyHuman(structuredClone(snapshot))!==true) return {reserved:false,reason:'approval_invalid'};
      const executionId=crypto.randomUUID();
      await store.patch(approvalId,snapshot.etag,{executionId,executionStatus:'reserved',
        executionResult:JSON.stringify({executionId,changeHash:hash,reservedAt:new Date(t).toISOString()})});
      const confirmed=await store.read(approvalId);
      if(!validTag(confirmed?.etag)||confirmed.etag===snapshot.etag||
         confirmed.record?.executionId!==executionId||confirmed.record?.executionStatus!=='reserved'||
         confirmed.record?.changeHash!==hash||confirmed.record?.revoked!==false||
         confirmed.record?.status!=='APPROVED'||
         confirmed.record?.executionResult!==JSON.stringify({executionId,changeHash:hash,reservedAt:new Date(t).toISOString()})) return {reserved:false,reason:'reservation_unconfirmed'};
      receipts.set(executionId,{approvalId:String(approvalId),etag:confirmed.etag,
        hash,executionResult:confirmed.record.executionResult,original:structuredClone(snapshot),expiresAt:end});
      return {reserved:true,executionId};
    }catch{return {reserved:false,reason:'reservation_failed_or_conflict'};}
  }
  async function recheck(approvalId,plan,executionId) {
    const receipt=receipts.get(executionId);
    if(!receipt||receipt.approvalId!==String(approvalId)) return false;
    // Claim synchronously before asynchronous reads: concurrent attempts fail closed.
    receipts.delete(executionId);
    try {
      const hash=changeHash(plan),t=now();
      if(hash!==receipt.hash||t>=receipt.expiresAt) return false;
      const current=await store.read(approvalId),record=current?.record;
      if(!validTag(current?.etag)||current.etag!==receipt.etag||
         record?.executionId!==executionId||record?.executionStatus!=='reserved'||
         record?.changeHash!==hash||record?.executionResult!==receipt.executionResult||
         record?.revoked!==false||record?.status!=='APPROVED') return false;
      const original=receipt.original.record;
      if(record.approver!==original.approver||record.approvedAt!==original.approvedAt||
         record.runtimeCommitSha!==original.runtimeCommitSha||
         record.operation!==original.operation||record.siteId!==original.siteId||
         record.listId!==original.listId||record.itemId!==original.itemId) return false;
      const decision={...record};delete decision.executionId;delete decision.executionStatus;
      verifyApproval(plan,decision);
      if(await store.verifyHuman(structuredClone(receipt.original))!==true) return false;
      const final=await store.read(approvalId);
      return Boolean(final?.etag===receipt.etag&&final.record?.executionId===executionId&&
        final.record?.executionStatus==='reserved'&&final.record?.revoked===false&&
        final.record?.status==='APPROVED'&&final.record?.changeHash===hash&&
        final.record?.executionResult===receipt.executionResult&&
        Date.parse(final.record?.expiresAt)>now());
    }catch{return false;}
  }
  return {reserve,recheck};
}
module.exports={createSharePointApprovalReservation};
