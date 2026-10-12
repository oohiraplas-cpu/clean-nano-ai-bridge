'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSharePointApprovalRecheck}=require('../src/sharePointApprovalRecheckDraft');
const {changeHash}=require('../src/sharePointMutationContractDraft');
const plan={operation:'create_item',siteId:'tenant,site,web',listId:'list-1',runtimeCommitSha:'a'.repeat(40),params:{fields:{Title:'Test'}}};
const hash=changeHash(plan), now=Date.parse('2026-10-13T10:00:00Z');
const record={status:'APPROVED',revoked:false,operation:plan.operation,siteId:plan.siteId,listId:plan.listId,runtimeCommitSha:plan.runtimeCommitSha,changeHash:hash,approver:'person',approvedAt:'2026-10-13T09:00:00Z',expiresAt:'2026-10-13T11:00:00Z',executionId:'exec-1',executionStatus:'reserved'};
const snapshot={etag:'"1"',record:{...record,executionId:undefined,executionStatus:undefined}};
const confirmed={etag:'"2"'};
const args={plan,approvalId:'1',receipt:{executionId:'exec-1'},snapshot,confirmed};
function make(overrides={}){return createSharePointApprovalRecheck({readApproval:async()=>({etag:'"2"',record}),verifyHuman:async()=>true,now:()=>now,...overrides});}
test('approved current reservation rechecks successfully',async()=>assert.equal(await make()(args),true));
test('revoked and expired decisions fail closed',async()=>{
 for(const change of [{revoked:true},{expiresAt:'2026-10-13T09:59:59Z'},{executionId:'other'}]){
  assert.equal(await make({readApproval:async()=>({etag:'"2"',record:{...record,...change}})})(args),false);
 }
});
test('ETag conflict and identity failure deny',async()=>{
 assert.equal(await make({readApproval:async()=>({etag:'"3"',record})})(args),false);
 assert.equal(await make({verifyHuman:async()=>false})(args),false);
});
test('revocation during identity check denies',async()=>{
 let count=0;
 const check=make({readApproval:async()=>({etag:'"2"',record:{...record,revoked:++count>1}})});
 assert.equal(await check(args),false);
});
