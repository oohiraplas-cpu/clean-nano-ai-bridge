'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {inspectPowerAppsStructure}=require('../src/bridgeEnhancedFeatures');
test('cross-app inspection uses explicit app/environment, never configured app',async()=>{
 let legacyCalls=0,observed;
 const result=await inspectPowerAppsStructure({
   appId:'other-app',environmentId:'other-env',
   powerAppsStore:{
     async getAppInfo(){legacyCalls++;return {appId:'configured-app'}},
     async getAppInfoForEnvironment(input){observed=input;return {appId:input.appId,environmentId:input.environmentId,displayName:'Other'}}
   }
 });
 assert.deepEqual(observed,{appId:'other-app',environmentId:'other-env'});
 assert.equal(legacyCalls,0);
 assert.equal(result.data.structure.appId,'other-app');
 assert.equal(result.verified,false); // metadata is not a verified screen/source inspection
 assert.equal(result.data.structure.screens.count,0);
});
test('cross-app read fails closed when per-target reader is absent',async()=>{
 const result=await inspectPowerAppsStructure({appId:'other-app',environmentId:'other-env',powerAppsStore:{async getAppInfo(){throw Error('must not call')}}});
 assert.equal(result.verified,false);
 assert.equal(result.status,'error');
});
test('configured-app mismatch remains rejected without explicit environment',async()=>{
 const result=await inspectPowerAppsStructure({appId:'other-app',powerAppsStore:{async getAppInfo(){return {appId:'configured-app'}}}});
 assert.equal(result.status,'error');
 assert.equal(result.verified,false);
});
test('server forwards environment scope and retains state manager checks',()=>{
 const s=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
 assert.match(s,/appId: params\.appId,\s*environmentId: params\.environmentId/);
 assert.match(s,/stateRegistry\.validate\(/);
 assert.match(s,/stateSessionId/);
});
