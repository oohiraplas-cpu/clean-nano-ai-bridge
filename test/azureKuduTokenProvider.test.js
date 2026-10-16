'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createKuduTokenProvider}=require('../src/azureKuduTokenProvider');
test('Kudu provider requests only approved ARM audience without leaking token',async()=>{
 let received;
 const get=createKuduTokenProvider({getAccessToken:async audience=>{received=audience;return 'secret-token';}});
 assert.equal(await get(),'secret-token');
 assert.equal(received,'https://management.azure.com/');
});
test('Kudu provider rejects absent provider and unapproved audience',()=>{
 assert.throws(()=>createKuduTokenProvider(),/token_provider_required/);
 assert.throws(()=>createKuduTokenProvider({getAccessToken:async()=>'',audience:'https://untrusted.example/'}),/audience_unapproved/);
});
test('Kudu provider fails closed and masks upstream errors',async()=>{
 for(const fn of [async()=>'',async()=>{throw new Error('secret-token-in-error');}]){
  await assert.rejects(createKuduTokenProvider({getAccessToken:fn})(),err=>err.message==='kudu_aad_auth_unverified');
 }
});

test('Kudu provider rejects whitespace-only token and masks rejection details',async()=>{
 const get=createKuduTokenProvider({getAccessToken:async()=> '   '});
 await assert.rejects(get(),err=>err.message==='kudu_aad_auth_unverified');
});
