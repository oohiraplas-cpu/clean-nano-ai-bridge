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
 assert.equal((await adapter.diagnose()).verified,false);
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
