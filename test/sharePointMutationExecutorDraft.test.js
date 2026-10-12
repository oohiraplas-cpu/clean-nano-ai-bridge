'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSharePointMutationExecutor}=require('../src/sharePointMutationExecutorDraft');
const {changeHash}=require('../src/sharePointMutationContractDraft');
const plan={operation:'create_item',siteId:'tenant,site,web',listId:'list-1',runtimeCommitSha:'a'.repeat(40),params:{fields:{Title:'Test'}}};
function fixtures(overrides={}) {
 const calls=[];
 const deps={
  loadApproval:async()=>({etag:'"1"',record:{status:'APPROVED',operation:plan.operation,siteId:plan.siteId,listId:plan.listId,runtimeCommitSha:plan.runtimeCommitSha,changeHash:changeHash(plan),approver:'person',approvedAt:'2026-10-13T00:00:00Z'}}),
  verifyHuman:async()=>true,
  reserveETag:async()=>({reserved:true,executionId:'once'}),
  readReservation:async()=>({executionId:'once',changeHash:changeHash(plan),status:'reserved'}),
  readRuntimeSha:async()=>plan.runtimeCommitSha,
  backup:async()=>({verified:true,reference:'snapshot'}),
  recheck:async()=>true,
  writer:{createItemFields:async()=>{calls.push('write');return {id:'1'};}},
  readback:async()=>true,
  audit:async()=>{calls.push('audit');}
 };
 return {calls,deps:{...deps,...overrides}};
}
test('missing security dependencies fail closed',async()=>{
 assert.equal((await createSharePointMutationExecutor({})(plan,'1')).status,'BLOCKED');
});
test('unverified human and missing backup never write',async()=>{
 for (const overrides of [{verifyHuman:async()=>false},{backup:async()=>({verified:false})},{recheck:async()=>false}]) {
  const {calls,deps}=fixtures(overrides);
  assert.equal((await createSharePointMutationExecutor(deps)(plan,'1')).status,'BLOCKED');
  assert.deepEqual(calls,[]);
 }
});
test('successful verified path calls writer once and audits',async()=>{
 const {calls,deps}=fixtures();
 assert.equal((await createSharePointMutationExecutor(deps)(plan,'1')).status,'VERIFIED');
 assert.deepEqual(calls,['write','audit']);
});
test('readback failure does not claim success',async()=>{
 const {calls,deps}=fixtures({readback:async()=>false});
 assert.equal((await createSharePointMutationExecutor(deps)(plan,'1')).status,'BLOCKED');
 assert.deepEqual(calls,['write']);
});
