'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createDirectoryHumanVerifier}=require('../src/sharePointDirectoryVerifierDraft');
const id='12345678-1234-4234-8234-123456789abc';
test('allowlisted active Entra object ID requires fresh directory lookup',async()=>{
 let reads=0;
 const verify=createDirectoryHumanVerifier({allowedObjectIds:[id],fetchDirectoryUser:async()=>{reads++;return {id,accountEnabled:true};}});
 assert.equal(await verify(id),true);
 assert.equal(await verify(id),true);
 assert.equal(reads,2);
});
test('unlisted identity cannot trigger directory lookup',async()=>{
 let reads=0;
 const verify=createDirectoryHumanVerifier({allowedObjectIds:[id],fetchDirectoryUser:async()=>{reads++;return {id,accountEnabled:true};}});
 assert.equal(await verify('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),false);
 assert.equal(reads,0);
});
test('disabled, mismatched, and directory error fail closed',async()=>{
 for(const fetchDirectoryUser of [async()=>({id,accountEnabled:false}),async()=>({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accountEnabled:true}),async()=>{throw Error('unavailable');}]){
  const verify=createDirectoryHumanVerifier({allowedObjectIds:[id],fetchDirectoryUser});
  assert.equal(await verify(id),false);
 }
});
test('missing allowlist or directory provider rejects configuration',()=>{
 assert.throws(()=>createDirectoryHumanVerifier({allowedObjectIds:[id]}));
 assert.throws(()=>createDirectoryHumanVerifier({allowedObjectIds:[],fetchDirectoryUser:async()=>({id,accountEnabled:true})}));
});
