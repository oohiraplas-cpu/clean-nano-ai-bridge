'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSharePointApprovalStore}=require('../src/sharePointApprovalStoreDraft');
const names=['status','revoked','operation','siteId','listId','itemId','runtimeCommitSha','changeHash','approver','approvedAt','expiresAt','executionId','executionStatus','executionResult'];
const fieldMap=Object.fromEntries(names.map(k=>[k,k]));
function setup({code=200,human=true}={}){
 const calls=[];
 const writer={graphBaseUrl:'https://graph.microsoft.com/v1.0',_getAccessToken:async()=> 'token',
  _fetch:async(url,options)=>{calls.push({url,options});return {ok:code<400,status:code,headers:{get:()=>'"3"'},json:async()=>({approver:'person',status:'APPROVED'})};}};
 return {calls,store:createSharePointApprovalStore({writer,siteId:'site',listId:'list',fieldMap,verifyDirectoryHuman:async()=>human})};
}
test('Graph approval read obtains server ETag and independent identity',async()=>{
 const {store,calls}=setup();
 const result=await store.read('1');
 assert.equal(result.etag,'"3"');
 assert.equal(await store.verifyHuman(result),true);
 assert.equal(calls[0].options.method,'GET');
});
test('PATCH requires exact If-Match and reservation-only fields',async()=>{
 const {store,calls}=setup();
 await store.patch('1','"3"',{executionId:'run'});
 assert.equal(calls[0].options.headers['If-Match'],'"3"');
 await assert.rejects(()=>store.patch('1','*',{executionId:'run'}));
 await assert.rejects(()=>store.patch('1','"3"',{status:'APPROVED'}));
});
test('Graph 412 conflict fails closed',async()=>{
 const {store}=setup({code:412});
 await assert.rejects(()=>store.patch('1','"3"',{executionId:'run'}));
});
test('missing directory verifier prevents store configuration',()=>{
 const store=createSharePointApprovalStore({writer:{},siteId:'s',listId:'l',fieldMap});
 assert.throws(()=>store.assertConfigured());
});
