'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {validatePlan,changeHash,verifyApproval,canonical} = require('../src/sharePointMutationContractDraft');
const sha='a'.repeat(40);
const base={operation:'create_item',siteId:'tenant,site,web',listId:'list-1',runtimeCommitSha:sha,params:{fields:{Title:'Daily'}}};
test('approval binds target and exact change',()=>{
 const digest=changeHash(base);
 const approval={status:'APPROVED',operation:base.operation,siteId:base.siteId,listId:base.listId,runtimeCommitSha:sha,changeHash:digest,approver:'human',approvedAt:'2026-10-13T00:00:00Z'};
 assert.equal(verifyApproval(base,approval),digest);
 assert.throws(()=>verifyApproval({...base,params:{fields:{Title:'Changed'}}},approval));
});
test('rejects destructive and unsupported column operations',()=>{
 assert.throws(()=>validatePlan({...base,operation:'delete_list'}));
 assert.throws(()=>validatePlan({...base,operation:'create_column',params:{name:'Salary',displayName:'Salary',columnDefinition:{name:'Salary',displayName:'Salary',required:true,text:{}}}}));
 assert.throws(()=>validatePlan({...base,operation:'create_column',params:{name:'Salary',displayName:'Salary',columnDefinition:{name:'Salary',displayName:'Salary',unsupported:{}}}}));
 assert.throws(()=>validatePlan({...base,params:{fields:{createdBy:'x'}}}));
});
test('canonical rejects unsupported nested values',()=>{
 assert.throws(()=>canonical({x:undefined}));
 assert.throws(()=>canonical({x:Infinity}));
});
