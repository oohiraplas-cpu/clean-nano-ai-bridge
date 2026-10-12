'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createGuardedSharePointExecutor}=require('../src/sharePointGuardedExecutorDraft');
const {changeHash}=require('../src/sharePointMutationContractDraft');
const plan={operation:'create_item',siteId:'tenant,site,web',listId:'list-1',runtimeCommitSha:'a'.repeat(40),params:{fields:{Title:'Test'}}};
const now=()=>Date.parse('2026-10-13T10:00:00Z');
function fixture({conflict=false,backupOk=true,readbackOk=true,identityOk=true,revokeAtRead=0}={}){
 const calls=[];let etag='"1"',reads=0;
 const record={status:'APPROVED',revoked:false,operation:plan.operation,siteId:plan.siteId,listId:plan.listId,runtimeCommitSha:plan.runtimeCommitSha,changeHash:changeHash(plan),approver:'owner',approvedAt:'2026-10-13T09:00:00Z',expiresAt:'2026-10-13T11:00:00Z'};
 const store={assertConfigured(){},verifyHuman:async()=>identityOk,
  read:async()=>{reads++;if(revokeAtRead&&reads===revokeAtRead){record.revoked=true;etag='"3"';}return {etag,record:{...record}};},
  patch:async(_id,match,fields)=>{if(conflict||etag!==match)throw Error('412');Object.assign(record,fields);etag='"2"';}};
 const writer={createItemFields:async()=>{calls.push('write');return {id:'item-1'};},
  getItemFields:async()=>{calls.push('readback');return readbackOk?{Title:'Test'}:{Title:'wrong'};}};
 const execute=createGuardedSharePointExecutor({store,writer,now,readRuntimeSha:async()=>plan.runtimeCommitSha,
  backup:async()=>{calls.push('backup');return {verified:backupOk,reference:backupOk?'snapshot':null};},
  audit:async()=>{calls.push('audit');}});
 return {execute,calls,record};
}
test('guarded executor backs up, reserves, writes, reads back and audits',async()=>{
 const {execute,calls}=fixture();
 assert.equal((await execute(plan,'1')).status,'VERIFIED');
 assert.deepEqual(calls,['backup','write','readback','audit']);
 assert.equal((await execute(plan,'1')).status,'BLOCKED');
 assert.equal(calls.filter(c=>c==='write').length,1);
});
test('ETag conflict blocks before Graph mutation',async()=>{
 const {execute,calls}=fixture({conflict:true});
 assert.equal((await execute(plan,'1')).status,'BLOCKED');
 assert.equal(calls.includes('write'),false);
});
test('unverified identity or backup blocks before mutation',async()=>{
 for(const options of [{identityOk:false},{backupOk:false}]){
  const {execute,calls}=fixture(options);
  assert.equal((await execute(plan,'1')).status,'BLOCKED');
  assert.equal(calls.includes('write'),false);
 }
});
test('Graph readback mismatch blocks VERIFIED and audit',async()=>{
 const {execute,calls}=fixture({readbackOk:false});
 assert.equal((await execute(plan,'1')).status,'BLOCKED');
 assert.deepEqual(calls,['backup','write','readback']);
});
test('revocation after reservation blocks before write',async()=>{
 const {execute,calls,record}=fixture();
 const result=await execute(plan,'1');
 assert.equal(result.status,'VERIFIED');
 record.revoked=true;
 assert.equal((await execute(plan,'1')).status,'BLOCKED');
 assert.equal(calls.filter(c=>c==='write').length,1);
});

test('revocation between reservation and final recheck prevents write',async()=>{
 const {execute,calls}=fixture({revokeAtRead:4});
 assert.equal((await execute(plan,'1')).status,'BLOCKED');
 assert.equal(calls.includes('write'),false);
});
test('two concurrent requests never both mutate',async()=>{
 const {execute,calls}=fixture();
 const results=await Promise.all([execute(plan,'1'),execute(plan,'1')]);
 assert.equal(results.filter(r=>r.status==='VERIFIED').length<=1,true);
 assert.equal(calls.filter(c=>c==='write').length<=1,true);
});
