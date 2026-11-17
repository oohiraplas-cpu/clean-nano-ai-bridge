'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createReadOnlyProviderAdapter}=require('../src/connectionProviderAdapters');
test('Azure verified probe reports success only after authorized operation',async()=>{
 const adapter=createReadOnlyProviderAdapter('azure',{probe:async()=>({status:200,configured:true,authorizedOperationVerified:true,accessToken:'NEVER_EXPOSE'})});
 const result=await adapter.diagnose();
 assert.equal(result.verified,true);
 assert.doesNotMatch(JSON.stringify(result),/NEVER_EXPOSE/);
});
test('Power Apps HTTP 200 without authorized operation is not verified',async()=>{
 const adapter=createReadOnlyProviderAdapter('powerApps',{probe:async()=>({status:200,configured:true})});
 const result=await adapter.diagnose();
 assert.equal(result.verified,false);
 assert.equal(result.status,'PARTIAL');
 assert.equal(result.reason,'authorized_operation_unverified');
});
test('Copilot Studio 401 is blocked',async()=>{
 const adapter=createReadOnlyProviderAdapter('copilotStudio',{probe:async()=>({status:401,configured:true})});
 assert.equal((await adapter.diagnose()).status,'BLOCKED');
});
test('provider exceptions do not leak credentials',async()=>{
 const adapter=createReadOnlyProviderAdapter('powerAutomate',{probe:async()=>{throw Error('SECRET_VALUE')}});
 const result=await adapter.diagnose();
 assert.equal(result.verified,false);
 assert.doesNotMatch(JSON.stringify(result),/SECRET_VALUE/);
});
test('invalid providers and malformed responses fail closed',async()=>{
 assert.throws(()=>createReadOnlyProviderAdapter('unknown',{probe:()=>{}}));
 const adapter=createReadOnlyProviderAdapter('azureAi',{probe:async()=>({status:'200',configured:true})});
 assert.equal((await adapter.diagnose()).status,'BLOCKED');
});

test('all providers require verified authorized operation before PASS',async()=>{
 for(const service of ['azure','azureAi','powerApps','powerAutomate','copilotStudio']){
  const a=createReadOnlyProviderAdapter(service,{probe:async()=>({status:200,configured:true,authorizedOperationVerified:false})});
  const r=await a.diagnose();
  assert.equal(r.status,'PARTIAL',service);
  assert.equal(r.verified,false,service);
 }
});
test('429, 403, and missing configuration do not report verified',async()=>{
 for(const [status,configured] of [[429,true],[403,true],[200,false]]){
  const a=createReadOnlyProviderAdapter('azure',{probe:async()=>({status,configured,authorizedOperationVerified:true})});
  const r=await a.diagnose();
  assert.notEqual(r.status,'PASS');
  assert.equal(r.verified,false);
 }
});

test('hung provider times out and fails closed without secret leakage',async()=>{
 const adapter=createReadOnlyProviderAdapter('azure',{probe:()=>new Promise(()=>{})},{timeoutMs:5});
 const result=await adapter.diagnose();
 assert.equal(result.status,'BLOCKED');
 assert.equal(result.reason,'provider_probe_failed');
 assert.equal(result.verified,false);
});
test('invalid provider timeout configuration is rejected',()=>{
 assert.throws(()=>createReadOnlyProviderAdapter('azure',{probe:async()=>({status:200,configured:true})},{timeoutMs:0}));
 assert.throws(()=>createReadOnlyProviderAdapter('azure',{probe:async()=>({status:200,configured:true})},{timeoutMs:Infinity}));
});
