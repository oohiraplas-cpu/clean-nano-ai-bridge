'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {waitForExecutionResult}=require('../src/executionFinalResponse');
test('completed response is final and truthful',async()=>{
 const r=await waitForExecutionResult({getStatus:()=>({requestId:'x',status:'完了'})},'x',{timeoutMs:0});
 assert.equal(r.terminal,true);assert.equal(r.resultKind,'completed');
});
test('approval remains blocked, never presented as success',async()=>{
 const r=await waitForExecutionResult({getStatus:()=>({requestId:'x',status:'人間承認待ち'})},'x',{timeoutMs:0});
 assert.equal(r.resultKind,'approval_required');assert.notEqual(r.resultKind,'completed');
});
test('unfinished execution times out with BLOCKED, no fake PASS',async()=>{
 const r=await waitForExecutionResult({getStatus:()=>({requestId:'x',status:'実行中'})},'x',{timeoutMs:0});
 assert.equal(r.status,'BLOCKED');assert.equal(r.terminal,false);
});
test('stopped execution is failure',async()=>{
 const r=await waitForExecutionResult({getStatus:()=>({requestId:'x',status:'停止'})},'x',{timeoutMs:0});
 assert.equal(r.resultKind,'failed');
});
test('invalid unbounded wait is refused',async()=>{
 await assert.rejects(()=>waitForExecutionResult({getStatus:()=>({status:'実行中'})},'x',{timeoutMs:30000}),RangeError);
});
