'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {PowerAppsRuntimeSourceAdapter}=require('../src/powerAppsRuntimeSource');
const content='Screen: S1';
const stateContext={appId:'app',environment:'env',branch:'main',canonicalBranch:'main',sha:'a'.repeat(40),correlationId:'corr'};
const config={appId:'app',environmentId:'env',canonicalBranch:'main',mode:'pac',sourceMap:{'S1.pa.yaml':'Src/S1.pa.yaml'}};
const worker=async()=>({status:'ok',appId:'app',environment:'env',entry:'Src/S1.pa.yaml',content});
test('PAC observation is bound using Git blob SHA',async()=>{
 const adapter=new PowerAppsRuntimeSourceAdapter(config,worker);
 let observed;
 const registry={lookup(){return {status:'ok'}},bindSourceObservation(correlation,session,scope,source,path){observed={correlation,session,scope,source,path};return {stateContextComplete:true}}};
 const result=await adapter.bindRuntimeObservation('S1.pa.yaml',{stateContext,assertStateContext(){},stateRegistry:registry,stateSessionId:'session',scope:'POWERAPPS_SOURCE_RESOLUTION'});
 const expected=crypto.createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0').update(content).digest('hex');
 assert.equal(observed.source.sha,expected);assert.equal(result.runtimeSourceVerified,true);
});
test('no registered session blocks PAC binding',async()=>{
 const adapter=new PowerAppsRuntimeSourceAdapter(config,worker);
 await assert.rejects(()=>adapter.bindRuntimeObservation('S1.pa.yaml',{stateContext,assertStateContext(){}}),/登録|照合|State Manager|取得/);
});

test('missing registered session blocks before PAC source binding',async()=>{
 const adapter=new PowerAppsRuntimeSourceAdapter(config,worker);
 let called=false;
 const registry={lookup(){return null},bindSourceObservation(){called=true;return {stateContextComplete:true}}};
 await assert.rejects(()=>adapter.bindRuntimeObservation('S1.pa.yaml',{stateContext,assertStateContext(){},stateRegistry:registry,stateSessionId:'session',scope:'POWERAPPS_SOURCE_RESOLUTION'}),/照合|登録/);
 assert.equal(called,false);
});
test('incomplete binding never reports verified PAC source',async()=>{
 const adapter=new PowerAppsRuntimeSourceAdapter(config,worker);
 const registry={lookup(){return {status:'ok'}},bindSourceObservation(){return {stateContextComplete:false}}};
 await assert.rejects(()=>adapter.bindRuntimeObservation('S1.pa.yaml',{stateContext,assertStateContext(){},stateRegistry:registry,stateSessionId:'session',scope:'POWERAPPS_SOURCE_RESOLUTION'}),/照合|登録/);
});

test('missing session never starts the PAC worker',async()=>{
 let calls=0;
 const adapter=new PowerAppsRuntimeSourceAdapter(config,async()=>{calls++;return worker();});
 const registry={lookup(){return null},bindSourceObservation(){throw Error('must not bind')}};
 await assert.rejects(()=>adapter.bindRuntimeObservation('S1.pa.yaml',{stateContext,assertStateContext(){},stateRegistry:registry,stateSessionId:'session',scope:'POWERAPPS_SOURCE_RESOLUTION'}),/登録|照合/);
 assert.equal(calls,0);
});
