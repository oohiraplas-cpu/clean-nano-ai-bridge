'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSharePointApprovalCasStore}=require('../src/sharePointApprovalCasStore');
const {createDurableApprovalService}=require('../src/durableConnectionApproval');
const fieldMap={requestId:'RequestId',status:'Status',version:'Version',source:'Source',presentedToUser:'Presented',subjectId:'SubjectId',targetId:'TargetId',service:'Service',action:'Action',expiresAt:'ExpiresAt'};
function fixture(){
 let state='pending',etag='"v1"',writes=0,readError=false,patchStatus=204;
 const fields={RequestId:'req-12345',Status:'pending',Source:'trusted_server',Presented:true,SubjectId:'user-1',TargetId:'resource-1',Service:'azure',Action:'rotate_credential',ExpiresAt:Date.now()+60000};
 const store=createSharePointApprovalCasStore({fieldMap,
  fetchItem:async()=>{if(readError)throw Error('private');return {id:'item-1',etag,fields:{...fields,Status:state}};},
  patchItem:async({itemId,ifMatch,fields:patch})=>{
   await new Promise(resolve=>setImmediate(resolve));
   if(itemId!=='item-1' || ifMatch!==etag || state!=='pending')return {status:412};
   writes++;
   if(patchStatus!==204)return {status:patchStatus};
   state=patch.Status;etag='"v2"';return {status:204};
  }
 });
 return {store,writes:()=>writes,setPatchStatus:x=>{patchStatus=x;},setReadError:x=>{readError=x;}};
}
test('single use across eight concurrent requests using ETag CAS',async()=>{
 const f=fixture(),svc=createDurableApprovalService(f.store);
 const args={requestId:'req-12345',subjectId:'user-1',targetId:'resource-1',utterance:'承認する'};
 const results=await Promise.all(Array.from({length:8},()=>svc.consume(args)));
 assert.equal(results.filter(x=>x.reason==='approval_consumed_no_write').length,1);
 assert.equal(f.writes(),1);
});
test('wrong target never writes',async()=>{
 const f=fixture(),svc=createDurableApprovalService(f.store);
 assert.equal((await svc.consume({requestId:'req-12345',subjectId:'user-1',targetId:'wrong',utterance:'承認する'})).status,'BLOCKED');
 assert.equal(f.writes(),0);
});
test('SharePoint conflict and unavailable service fail closed',async()=>{
 const f=fixture();f.setPatchStatus(412);
 const svc=createDurableApprovalService(f.store);
 const args={requestId:'req-12345',subjectId:'user-1',targetId:'resource-1',utterance:'承認する'};
 assert.equal((await svc.consume(args)).reason,'approval_already_consumed');
 f.setReadError(true);
 const r=await svc.consume(args);
 assert.equal(r.reason,'approval_store_unavailable');
 assert.doesNotMatch(JSON.stringify(r),/private/);
});
test('invalid schema and unexpected patch response fail closed',async()=>{
 assert.throws(()=>createSharePointApprovalCasStore({fetchItem:async()=>null,patchItem:async()=>null,fieldMap:{}}));
 const f=fixture();f.setPatchStatus(500);
 const svc=createDurableApprovalService(f.store);
 assert.equal((await svc.consume({requestId:'req-12345',subjectId:'user-1',targetId:'resource-1',utterance:'承認する'})).reason,'approval_store_unavailable');
});
