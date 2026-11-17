'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assessRecovery}=require('../src/lv5RecoveryGate');
const sha='a'.repeat(40);
const context={environment:'isolated',production:false,branch:'feature/test',sourceSha:sha};
const approval={verified:true,action:'rollback',branch:context.branch,sourceSha:sha};
const evidence={snapshotVerified:true,auditReady:true,premiumFreeVerified:true};
test('recovery rejects absent approval',()=>{
 assert.equal(assessRecovery({action:'rollback',context,evidence}).status,'BLOCKED');
});
test('recovery rejects production',()=>{
 assert.equal(assessRecovery({action:'rollback',context:{...context,production:true},approval,evidence}).status,'BLOCKED');
});
test('recovery rejects incomplete evidence',()=>{
 assert.equal(assessRecovery({action:'rollback',context,approval,evidence:{...evidence,auditReady:false}}).status,'BLOCKED');
});
test('recovery only returns eligibility',()=>{
 assert.equal(assessRecovery({action:'rollback',context,approval,evidence}).status,'ELIGIBLE_FOR_SEPARATE_AUTHORIZATION');
});
