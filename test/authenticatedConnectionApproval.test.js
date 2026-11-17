'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAuthenticatedApprovalHandler}=require('../src/authenticatedConnectionApproval');
function fixture(resolveVerifiedPrincipal){
 let consumed=false;
 const record={source:'trusted_server',status:'pending',presentedToUser:true,subjectId:'user-1',expiresAt:Date.now()+60000,version:'v1',service:'azure',action:'rotate_credential',targetId:'resource-1'};
 const store={get:async()=>record,compareAndSwap:async()=>{consumed=true;return true;}};
 return {handler:createAuthenticatedApprovalHandler({store,resolveVerifiedPrincipal}),wasConsumed:()=>consumed};
}
test('verified identity from auth middleware permits one approval consumption',async()=>{
 const {handler,wasConsumed}=fixture(async()=>({verified:true,subjectId:'user-1',issuer:'https://login.microsoftonline.com/tenant/v2.0',tenantId:'tenant'}));
 const r=await handler.consume({requestId:'request-123',targetId:'resource-1',utterance:'承認する',subjectId:'attacker'});
 assert.equal(r.reason,'approval_consumed_no_write');
 assert.equal(wasConsumed(),true);
});
test('caller-supplied identity never substitutes for verified principal',async()=>{
 const {handler,wasConsumed}=fixture(async()=>null);
 const r=await handler.consume({requestId:'request-123',targetId:'resource-1',utterance:'承認する',subjectId:'user-1'});
 assert.equal(r.status,'BLOCKED');
 assert.equal(wasConsumed(),false);
});
test('unverified and malformed principals fail closed',async()=>{
 for(const principal of [{verified:false,subjectId:'user-1',issuer:'x',tenantId:'t'},{verified:true,subjectId:'user-1',issuer:'',tenantId:'t'}]){
  const {handler,wasConsumed}=fixture(async()=>principal);
  assert.equal((await handler.consume({requestId:'request-123',targetId:'resource-1',utterance:'承認する'})).status,'BLOCKED');
  assert.equal(wasConsumed(),false);
 }
});
test('auth provider errors do not leak secrets',async()=>{
 const {handler,wasConsumed}=fixture(async()=>{throw Error('SECRET_TOKEN')});
 const r=await handler.consume({requestId:'request-123',targetId:'resource-1',utterance:'承認する'});
 assert.equal(r.status,'BLOCKED');
 assert.doesNotMatch(JSON.stringify(r),/SECRET_TOKEN/);
 assert.equal(wasConsumed(),false);
});
