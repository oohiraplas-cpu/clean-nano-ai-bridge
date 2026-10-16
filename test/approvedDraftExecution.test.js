'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {executeApprovedDraft}=require('../src/approvedDraftExecution');
const {hashPlan}=require('../src/approvedExecutionGateDraft');
const base={requestId:'r',targetId:'app',environmentId:'env',baseSha:'a'.repeat(40),headSha:'b'.repeat(40)};
test('unconfigured real API is blocked',async()=>{
  assert.equal((await executeApprovedDraft({plan:{...base,operation:'ci_verify'}})).status,'BLOCKED');
});
test('production cannot execute through Draft entrypoint',async()=>{
  let called=false;
  const r=await executeApprovedDraft({plan:{...base,operation:'powerapps_publish'},adapter:{applyDraftChange:async()=>{called=true;}}});
  assert.equal(r.status,'BLOCKED');assert.equal(called,false);
});
test('verified Draft adapter result needs matching plan hash and evidence',async()=>{
  const plan={...base,operation:'ci_verify'};
  const pass=await executeApprovedDraft({plan,adapter:{getCiEvidence:async()=>({verified:true,planHash:hashPlan(plan),evidenceId:'run-123'})}});
  assert.equal(pass.status,'PASS');
  const fail=await executeApprovedDraft({plan,adapter:{getCiEvidence:async()=>({verified:true,planHash:'wrong',evidenceId:'run-123'})}});
  assert.equal(fail.status,'BLOCKED');
});
test('API failures never imply success',async()=>{
  const plan={...base,operation:'draft_edit'};
  const r=await executeApprovedDraft({plan,adapter:{applyDraftChange:async()=>{throw Error('offline')}}});
  assert.equal(r.status,'BLOCKED');
});
