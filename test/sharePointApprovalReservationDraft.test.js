'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reserveApprovalDraft}=require('../src/sharePointApprovalReservationDraft');
const keys=['requestId','stepIndex','tool','status','approver','approvedAt','revoked','planHash','executionId'];
const fieldMap=Object.fromEntries(keys.map(k=>[k,'col_'+k]));
const config={siteId:'site',listId:'list',itemId:'42',fieldMap,approvedValue:'承認',reservedValue:'予約済'};
const expected={requestId:'req',stepIndex:1,tool:'publish_powerapps_app',planHash:'hash',approver:'human'};
function harness(status=204,mutate=true){
 const calls=[];let item={id:'42',eTag:'"v1"',fields:{
 col_requestId:'req',col_stepIndex:1,col_tool:'publish_powerapps_app',
 col_status:'承認',col_approver:'human',col_approvedAt:new Date().toISOString(),
 col_revoked:false,col_planHash:'hash',col_executionId:null}};
 const reader={_graphFetch:async()=>structuredClone(item)};
 const writer={patchItemFieldsIfMatch:async(s,l,id,fields,etag)=>{
 calls.push({s,l,id,fields,etag});
 if(status===412)return {status:'BLOCKED',reason:'etag_conflict'};
 if(mutate){item.fields={...item.fields,...fields};item.eTag='"v2"';}
 return {status:'ok'};
 }};
 return {reader,writer,calls,item};
}
test('verified approval reserves with ETag and independent reread',async()=>{
 const h=harness();const r=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected,executionId:'once'});
 assert.equal(r.status,'PASS');assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].etag,'"v1"');assert.equal(h.calls[0].fields.col_status,'予約済');
});
test('ETag conflict blocks without retry',async()=>{
 const h=harness(412);const r=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected,executionId:'once'});
 assert.equal(r.status,'BLOCKED');assert.equal(h.calls.length,1);
});
test('missing readback blocks',async()=>{
 const h=harness(204,false);const r=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected,executionId:'once'});
 assert.equal(r.status,'BLOCKED');
});
test('missing schema blocks without write',async()=>{
 const h=harness();const r=await reserveApprovalDraft({config:{...config,fieldMap:{...fieldMap,planHash:undefined}},reader:h.reader,writer:h.writer,expected,executionId:'once'});
 assert.equal(r.status,'BLOCKED');assert.equal(h.calls.length,0);
});
test('wrong plan hash blocks without write',async()=>{
 const h=harness();const r=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected:{...expected,planHash:'different'},executionId:'once'});
 assert.equal(r.status,'BLOCKED');assert.equal(h.calls.length,0);
});
test('revoked approval blocks without write',async()=>{
 const h=harness();h.item.fields.col_revoked=true;
 const r=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected,executionId:'once'});
 assert.equal(r.status,'BLOCKED');assert.equal(h.calls.length,0);
});

test('unverified or wrong expected approver blocks before write',async()=>{
 for(const approver of [undefined,'','other']) {
  const h=harness();const r=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected:{...expected,approver},executionId:'once'});
  assert.equal(r.status,'BLOCKED');assert.equal(h.calls.length,0);
 }
});
test('revocation during readback blocks',async()=>{
 const h=harness();const write=h.writer.patchItemFieldsIfMatch;
 h.writer.patchItemFieldsIfMatch=async(...args)=>{const result=await write(...args);h.item.fields.col_revoked=true;return result;};
 const r=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected,executionId:'once'});
 assert.equal(r.status,'BLOCKED');assert.equal(h.calls.length,1);
});
test('approval cannot be reserved twice',async()=>{
 const h=harness();const args={config,reader:h.reader,writer:h.writer,expected,executionId:'once'};
 assert.equal((await reserveApprovalDraft(args)).status,'PASS');
 assert.equal((await reserveApprovalDraft({...args,executionId:'twice'})).status,'BLOCKED');
 assert.equal(h.calls.length,1);
});

// Exercise the producer/consumer contract, not a hand-written proof object.
test('verified SharePoint reservation is accepted by execution and evidence gates',async()=>{
 const {authorizeExecution,hashPlan}=require('../src/approvedExecutionGateDraft');
 const {validateApprovalReservation}=require('../src/productionEvidenceGateDraft');
 const plan={requestId:'req',operation:'powerapps_publish',targetId:'app',environmentId:'env',headSha:'a'.repeat(40),baseSha:'b'.repeat(40)};
 const planHash=hashPlan(plan),h=harness();h.item.fields.col_planHash=planHash;
 const approval={...plan,status:'approved',revoked:false,planHash};
 let reservation;
 const result=await authorizeExecution({plan,approval,readHeadSha:async()=>plan.headSha,
  reserveApproval:async()=>reservation=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected:{...expected,planHash},executionId:'once'}),
  recheckApproval:async()=>h.item.fields.col_revoked===false && h.item.fields.col_executionId==='once'});
 assert.equal(result.status,'PASS');assert.equal(result.scope,'approved_single_use');
 assert.equal(validateApprovalReservation(reservation,{planHash,executionId:'once'}).status,'PASS');
 assert.equal(h.calls.length,1);
});
test('failed SharePoint reservation cannot pass the execution gate',async()=>{
 const {authorizeExecution,hashPlan}=require('../src/approvedExecutionGateDraft');
 const plan={requestId:'req',operation:'powerapps_publish',targetId:'app',environmentId:'env',headSha:'a'.repeat(40),baseSha:'b'.repeat(40)};
 const planHash=hashPlan(plan),h=harness(412);h.item.fields.col_planHash=planHash;
 let rechecked=false;
 const result=await authorizeExecution({plan,approval:{...plan,status:'approved',revoked:false,planHash},readHeadSha:async()=>plan.headSha,
  reserveApproval:()=>reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected:{...expected,planHash},executionId:'once'}),
  recheckApproval:async()=>{rechecked=true;return true;}});
 assert.equal(result.status,'BLOCKED');assert.equal(rechecked,false);
});

test('approval scope mismatch or revocation blocks before conditional write',async()=>{
 for(const [field,value] of [['col_requestId','wrong'],['col_stepIndex',2],['col_tool','other'],['col_revoked',true]]) {
  const h=harness();h.item.fields[field]=value;
  const result=await reserveApprovalDraft({config,reader:h.reader,writer:h.writer,expected,executionId:'once'});
  assert.equal(result.status,'BLOCKED',field);
  assert.equal(h.calls.length,0,field);
 }
});
