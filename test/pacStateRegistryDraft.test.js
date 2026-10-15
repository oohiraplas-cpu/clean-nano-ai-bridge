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

test('PAC evidence refuses source drift against registered Git content',async()=>{
 const {readPacEvidenceWithRegisteredState}=require('../src/pacStateEvidence');
 const registeredRecord={context:{...stateContext},source:{path:'S1.pa.yaml',content}};
 const goodHash=crypto.createHash('sha256').update(content).digest('hex');
 const args={registeredRecord,relativePath:'S1.pa.yaml',validateRegisteredState:()=>registeredRecord};
 const adapter={getSourceEvidence:async()=>({status:'ok',trustedAdapterVerified:true,runtimeHash:'f'.repeat(64)})};
 await assert.rejects(()=>readPacEvidenceWithRegisteredState({...args,adapter}),/pac_registered_source_mismatch/);
 adapter.getSourceEvidence=async()=>({status:'ok',trustedAdapterVerified:true,runtimeHash:goodHash});
 assert.equal((await readPacEvidenceWithRegisteredState({...args,adapter})).runtimeHash,goodHash);
});

const {StateContextRegistry,blobSha}=require('../src/stateContext');

test('registered session preserves commit SHA while binding observed blob SHA',()=>{
 const registry=new StateContextRegistry();
 const commit='a'.repeat(40);
 const issued=registry.begin({appId:'app',environmentId:'env',branch:'main',canonicalBranch:'main',sha:commit},'POWERAPPS_SOURCE_RESOLUTION');
 assert.notEqual(issued.stateSessionId,issued.correlationId);
 const observation={path:'Src/S1.pa.yaml',content,sha:blobSha(content)};
 assert.notEqual(observation.sha,commit);
 const bound=registry.bindSourceObservation(issued.correlationId,issued.stateSessionId,'POWERAPPS_SOURCE_RESOLUTION',observation,observation.path);
 assert.equal(bound.stateContext.sha,commit);
 assert.equal(bound.sourceObservationComplete,true);
 assert.equal(registry.lookup(issued.correlationId,issued.stateSessionId,'POWERAPPS_SOURCE_RESOLUTION').source.sha,observation.sha);
});

test('StateRegistry rejects wrong session and tampered source without binding',()=>{
 const registry=new StateContextRegistry();
 const issued=registry.begin({appId:'app',environmentId:'env',branch:'main',canonicalBranch:'main',sha:'a'.repeat(40)},'POWERAPPS_SOURCE_RESOLUTION');
 const observation={path:'Src/S1.pa.yaml',content,sha:blobSha(content)};
 assert.throws(()=>registry.bindSourceObservation(issued.correlationId,issued.correlationId,'POWERAPPS_SOURCE_RESOLUTION',observation,observation.path),/session mismatch/);
 assert.throws(()=>registry.bindSourceObservation(issued.correlationId,issued.stateSessionId,'POWERAPPS_SOURCE_RESOLUTION',{...observation,content:'tampered'},observation.path),/blob SHA/);
 assert.equal(registry.response(registry.lookup(issued.correlationId,issued.stateSessionId,'POWERAPPS_SOURCE_RESOLUTION')).sourceObservationComplete,false);
});
