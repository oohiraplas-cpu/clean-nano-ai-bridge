'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createGraphApprovalTransport}=require('../src/graphApprovalTransport');
const config={siteId:'tenant.sharepoint.com,site-guid,web-guid',listId:'11111111-1111-4111-8111-111111111111',requestIdColumn:'RequestId',accessToken:async()=> 'MOCK_TOKEN'};
test('Graph lookup is read-only, escaped, and returns ETag',async()=>{
 let called;
 const t=createGraphApprovalTransport({...config,fetchImpl:async(url,opts)=>{called={url,opts};return {status:200,json:async()=>({value:[{id:'12','@odata.etag':'"v1"',fields:{RequestId:"a'b"}}]})};}});
 const item=await t.fetchItem("a'b");
 assert.equal(item.etag,'"v1"');
 assert.match(decodeURIComponent(called.url),/a''b/);
 assert.equal(called.opts.method,'GET');
});
test('Graph PATCH requires If-Match and exact consumed status',async()=>{
 let called;
 const t=createGraphApprovalTransport({...config,fetchImpl:async(url,opts)=>{called={url,opts};return {status:204};}});
 assert.equal((await t.patchItem({itemId:'12',ifMatch:'"v1"',fields:{Status:'consumed'}})).status,204);
 assert.equal(called.opts.headers['If-Match'],'"v1"');
 assert.equal(called.opts.method,'PATCH');
 await assert.rejects(t.patchItem({itemId:'12',ifMatch:'*',fields:{Status:'consumed'}}),/unsafe_approval_patch/);
 await assert.rejects(t.patchItem({itemId:'12',ifMatch:'"v1"',fields:{Status:'approved'}}),/unsafe_approval_patch/);
});
test('duplicate rows and nextLink fail closed',async()=>{
 for(const body of [{value:[{id:'1'},{id:'2'}]},{value:[],'@odata.nextLink':'next'}]){
  const t=createGraphApprovalTransport({...config,fetchImpl:async()=>({status:200,json:async()=>body})});
  await assert.rejects(t.fetchItem('req'),/approval_lookup_ambiguous/);
 }
});
test('authorization failure and Graph errors do not leak credentials',async()=>{
 const t=createGraphApprovalTransport({...config,accessToken:async()=>{throw Error('PRIVATE_TOKEN')},fetchImpl:async()=>({status:200})});
 await assert.rejects(t.fetchItem('req'));
 const denied=createGraphApprovalTransport({...config,fetchImpl:async()=>({status:403})});
 await assert.rejects(denied.fetchItem('req'),/graph_read_failed/);
});
