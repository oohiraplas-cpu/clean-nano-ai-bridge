'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSharePointApprovalReservation}=require('../src/sharePointApprovalReservationDraft');
const {changeHash}=require('../src/sharePointMutationContractDraft');
const plan={operation:'create_item',siteId:'tenant,site,web',listId:'list-1',runtimeCommitSha:'a'.repeat(40),params:{fields:{Title:'Test'}}};
const t=Date.parse('2026-10-13T10:00:00Z');
function mock(){
 const record={status:'APPROVED',revoked:false,operation:plan.operation,siteId:plan.siteId,listId:plan.listId,runtimeCommitSha:plan.runtimeCommitSha,changeHash:changeHash(plan),approver:'owner',approvedAt:'2026-10-13T09:00:00Z',expiresAt:'2026-10-13T11:00:00Z'};
 let etag='"1"',patchCount=0;
 return {record,store:{assertConfigured(){},read:async()=>({etag,record:{...record}}),
 verifyHuman:async()=>true,patch:async(_id,match,fields)=>{if(match!==etag)throw Error('412');patchCount++;Object.assign(record,fields);etag='"2"';}},
 count:()=>patchCount};
}
test('reservation rejects changed initial ETag',async()=>{
 const {store,count}=mock(),gate=createSharePointApprovalReservation({store,now:()=>t});
 assert.equal((await gate.reserve('1',plan,'"0"')).reserved,false);
 assert.equal(count(),0);
});
test('reservation confirms exact result and single-use recheck',async()=>{
 const {store}=mock(),gate=createSharePointApprovalReservation({store,now:()=>t});
 const a=await gate.reserve('1',plan,'"1"');
 assert.equal(a.reserved,true);
 assert.equal(await gate.recheck('1',plan,a.executionId),true);
 assert.equal(await gate.recheck('1',plan,a.executionId),false);
});
test('modified reservation result fails closed',async()=>{
 const {store,record}=mock(),gate=createSharePointApprovalReservation({store,now:()=>t});
 const a=await gate.reserve('1',plan,'"1"');
 record.executionResult='tampered';
 assert.equal(await gate.recheck('1',plan,a.executionId),false);
});
