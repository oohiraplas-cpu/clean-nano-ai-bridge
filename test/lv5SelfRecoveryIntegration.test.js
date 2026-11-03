'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {SelfRecoveryService,RECOVERY_STATE}=require('../src/selfRecoveryService');
test('Lv5 opt-in blocks auto renewal without touching state store',async()=>{
 let writes=0;const service=new SelfRecoveryService({lv5GuardEnabled:true,stateContextStore:{get:()=>({contextId:'x'}),set:()=>{writes++;}}});
 const r=await service.executeRecovery('EXPIRED_STATE_CONTEXT',{contextId:'x'});
 assert.equal(r.state,RECOVERY_STATE.NEEDS_APPROVAL);
 assert.equal(r.executionAllowed,false);
 assert.equal(writes,0);
});
test('Lv5 opt-in blocks approval bypass',async()=>{
 const service=new SelfRecoveryService({lv5GuardEnabled:true});
 const p=await service.executeRecovery('POLICY_DENIED',{});
 const r=await service.approveRecovery(p.recoveryId,'approver');
 assert.equal(r.success,false);
 assert.equal(r.executionAllowed,false);
 assert.equal(r.state,RECOVERY_STATE.NEEDS_APPROVAL);
});
test('Lv5 opt-in does not execute even with eligible decision',async()=>{
 let writes=0;const service=new SelfRecoveryService({lv5GuardEnabled:true,stateContextStore:{get:()=>({contextId:'x'}),set:()=>{writes++;}}});
 const branch='feature/bridge-max-lv5-safe-parallel-20261104',sourceSha='a'.repeat(40);
 const r=await service.executeRecovery('EXPIRED_STATE_CONTEXT',{contextId:'x',lv5Context:{environment:'isolated',branch,sourceSha},lv5Approval:{verified:true,action:'repair',branch,sourceSha},lv5Evidence:{snapshotVerified:true,auditReady:true,premiumFreeVerified:true}});
 assert.equal(r.gate.status,'ELIGIBLE_FOR_SEPARATE_AUTHORIZATION');
 assert.equal(r.executionAllowed,false);assert.equal(writes,0);
});
