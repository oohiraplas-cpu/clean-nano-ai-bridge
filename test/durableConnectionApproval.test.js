'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createDurableApprovalService}=require('../src/durableConnectionApproval');
test('approval is single-use via transactional store',async()=>{
 let state='pending';
 const record={source:'trusted_server',status:'pending',presentedToUser:true,subjectId:'subject-1',expiresAt:Date.now()+60000,version:'v1',service:'azure',action:'rotate_credential'};
 const store={get:async()=>({...record,status:state}),compareAndSwap:async(_id,_version,expected,next)=>{if(state!==expected)return false;state=next;return true;}};
 const svc=createDurableApprovalService(store);
 assert.equal((await svc.consume({requestId:'request-123',subjectId:'subject-1',utterance:'承認する'})).reason,'approval_consumed_no_write');
 assert.equal((await svc.consume({requestId:'request-123',subjectId:'subject-1',utterance:'承認する'})).status,'BLOCKED');
});
test('wrong identity and storage failure fail closed',async()=>{
 const record={source:'trusted_server',status:'pending',presentedToUser:true,subjectId:'subject-1',expiresAt:Date.now()+60000,version:'v1'};
 const svc=createDurableApprovalService({get:async()=>record,compareAndSwap:async()=>true});
 assert.equal((await svc.consume({requestId:'request-123',subjectId:'other',utterance:'承認する'})).status,'BLOCKED');
 const broken=createDurableApprovalService({get:async()=>{throw Error('secret');},compareAndSwap:async()=>true});
 assert.equal((await broken.consume({requestId:'request-123',subjectId:'subject-1',utterance:'承認する'})).reason,'approval_store_unavailable');
});

test('durable approval rejects missing operation scope',async()=>{
 const record={source:'trusted_server',status:'pending',presentedToUser:true,subjectId:'subject-1',expiresAt:Date.now()+60000,version:'v1',service:'azure'};
 let mutated=false;
 const svc=createDurableApprovalService({get:async()=>record,compareAndSwap:async()=>{mutated=true;return true;}});
 const result=await svc.consume({requestId:'request-123',subjectId:'subject-1',utterance:'承認する'});
 assert.equal(result.status,'BLOCKED');
 assert.equal(mutated,false);
});

test('concurrent approval attempts consume exactly once',async()=>{
 let state='pending';
 const record={source:'trusted_server',status:'pending',presentedToUser:true,subjectId:'subject-1',expiresAt:Date.now()+60000,version:'v1',service:'azure',action:'rotate_credential'};
 const svc=createDurableApprovalService({
   get:async()=>({...record,status:state}),
   compareAndSwap:async(_id,_version,expected,next)=>{
     await new Promise(resolve=>setImmediate(resolve));
     if(state!==expected)return false;
     state=next;return true;
   }
 });
 const results=await Promise.all(Array.from({length:8},()=>svc.consume({requestId:'request-123',subjectId:'subject-1',utterance:'承認する'})));
 assert.equal(results.filter(r=>r.reason==='approval_consumed_no_write').length,1);
 assert.equal(results.filter(r=>r.status==='BLOCKED').length,7);
});
test('storage compare-and-swap exception fails closed',async()=>{
 const record={source:'trusted_server',status:'pending',presentedToUser:true,subjectId:'subject-1',expiresAt:Date.now()+60000,version:'v1',service:'azure',action:'rotate_credential'};
 const svc=createDurableApprovalService({get:async()=>record,compareAndSwap:async()=>{throw Error('PRIVATE_KEY')}});
 const result=await svc.consume({requestId:'request-123',subjectId:'subject-1',utterance:'承認する'});
 assert.equal(result.status,'BLOCKED');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_KEY/);
});
