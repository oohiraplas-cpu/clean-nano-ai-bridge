'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {reviewLegacyRecovery}=require('../src/lv5LegacyRecoveryGuard');
const context={environment:'isolated',branch:'feature/bridge-max-lv5-safe-parallel-20261104',sourceSha:'a'.repeat(40)};
const evidence={snapshotVerified:true,auditReady:true,premiumFreeVerified:true};
test('legacy recovery rejects missing human approval',()=>{
 const r=reviewLegacyRecovery({legacyAction:'rollback_retry',context,evidence});
 assert.equal(r.status,'BLOCKED');assert.equal(r.executionAllowed,false);
});
test('legacy recovery never grants execution even with full evidence',()=>{
 const approval={verified:true,action:'rollback',branch:context.branch,sourceSha:context.sourceSha};
 const r=reviewLegacyRecovery({legacyAction:'rollback_retry',context,approval,evidence});
 assert.equal(r.status,'ELIGIBLE_FOR_SEPARATE_AUTHORIZATION');
 assert.equal(r.executionAllowed,false);
});
test('production and unknown legacy actions fail closed',()=>{
 const approval={verified:true,action:'rollback',branch:context.branch,sourceSha:context.sourceSha};
 assert.equal(reviewLegacyRecovery({legacyAction:'rollback_retry',context:{...context,production:true},approval,evidence}).status,'BLOCKED');
 assert.equal(reviewLegacyRecovery({legacyAction:'unexpected',context,approval,evidence}).status,'BLOCKED');
});
