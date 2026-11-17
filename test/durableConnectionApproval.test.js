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
