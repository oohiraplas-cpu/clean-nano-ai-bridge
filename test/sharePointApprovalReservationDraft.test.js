'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSharePointApprovalReservation}=require('../src/sharePointApprovalReservationDraft');
const {changeHash}=require('../src/sharePointMutationContractDraft');
const plan={operation:'create_item',siteId:'tenant,site,web',listId:'list-1',runtimeCommitSha:'a'.repeat(40),params:{fields:{Title:'Test'}}};
const time=Date.parse('2026-10-13T10:00:00Z');
function setup({conflict=false,human=true}={}){
 const record={status:'APPROVED',revoked:false,operation:plan.operation,siteId:plan.siteId,listId:plan.listId,runtimeCommitSha:plan.runtimeCommitSha,changeHash:changeHash(plan),approver:'person',approvedAt:'2026-10-13T09:00:00Z',expiresAt:'2026-10-13T11:00:00Z'};
 let etag='"1"',patches=0;
 const store={assertConfigured(){},verifyHuman:async()=>human,
  read:async()=>({etag,record:{...record}}),
  patch:async(id,match,fields)=>{patches++;if(conflict||match!==etag)throw Error('412');Object.assign(record,fields);etag='"2"';}};
 return {store,getPatches:()=>patches,record};
}
test('ETag reservation and recheck are single-use',async()=>{
 const {store,getPatches}=setup();
 const gate=createSharePointApprovalReservation({store,now:()=>time});
 const reserved=await gate.reserve('1',plan);
 assert.equal(reserved.reserved,true);
 assert.equal(getPatches(),1);
 assert.equal(await gate.recheck('1',plan,reserved.executionId),true);
 assert.equal(await gate.recheck('1',plan,reserved.executionId),false);
 assert.equal((await gate.reserve('1',plan)).reserved,false);
});
test('conflict and unverified human never authorize',async()=>{
 for(const options of [{conflict:true},{human:false}]){
  const {store}=setup(options);
  const gate=createSharePointApprovalReservation({store,now:()=>time});
  assert.equal((await gate.reserve('1',plan)).reserved,false);
 }
});
test('restart loses receipt and fails closed',async()=>{
 const {store}=setup();
 const a=createSharePointApprovalReservation({store,now:()=>time});
 const reserved=await a.reserve('1',plan);
 const restarted=createSharePointApprovalReservation({store,now:()=>time});
 assert.equal(await restarted.recheck('1',plan,reserved.executionId),false);
});
test('revocation after reservation denies',async()=>{
 const {store,record}=setup();
 const gate=createSharePointApprovalReservation({store,now:()=>time});
 const reserved=await gate.reserve('1',plan);
 record.revoked=true;
 assert.equal(await gate.recheck('1',plan,reserved.executionId),false);
});
