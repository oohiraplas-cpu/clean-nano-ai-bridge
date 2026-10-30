'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createArmHttpTransport}=require('../src/azureArmHttpTransport');
const sub='11111111-2222-3333-4444-555555555555';
const path='/subscriptions/'+sub+'/providers/Microsoft.Web/sites?api-version=2023-12-01';
test('only GET to approved ARM endpoint',async()=>{
 let called=0;
 const get=createArmHttpTransport({subscriptionId:sub,getToken:async()=> 'safe.token',fetchImpl:async(url,options)=>{called++;assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(new URL(url).hostname,'management.azure.com');return {ok:true,json:async()=>({value:[]})};}});
 assert.deepEqual(await get(path),{value:[]});assert.equal(called,1);
 await assert.rejects(get('/subscriptions/'+sub+'/providers/Microsoft.Authorization/roleAssignments?api-version=2023-12-01'),/arm_path_rejected/);
 assert.equal(called,1);
});
test('no token or invalid auth blocks without fetch',async()=>{
 let called=0;
 const get=createArmHttpTransport({subscriptionId:sub,getToken:async()=>'',fetchImpl:async()=>{called++;}});
 await assert.rejects(get(path),/arm_auth_unavailable/);assert.equal(called,0);
});
test('403 and network errors fail closed',async()=>{
 for(const fetchImpl of [async()=>({ok:false}),async()=>{throw new Error('secret detail');}]){
 const get=createArmHttpTransport({subscriptionId:sub,getToken:async()=> 'safe.token',fetchImpl});
 await assert.rejects(get(path),/arm_read_unavailable/);
 }
});
test('rejects redirect-like and encoded paths before token acquisition',async()=>{
 let tokenCalls=0;
 const get=createArmHttpTransport({subscriptionId:sub,getToken:async()=>{tokenCalls++;return 'safe.token';},fetchImpl:async()=>({ok:true,json:async()=>({})})});
 await assert.rejects(get(path+'%2F'),/arm_path_rejected/);
 await assert.rejects(get('https://evil.example/'+path),/arm_path_rejected/);
 assert.equal(tokenCalls,0);
});
