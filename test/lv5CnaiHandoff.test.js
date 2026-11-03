'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareHandoff}=require('../src/lv5CnaiHandoff');
const input={requestId:'cnai_req_001',origin:'CNAI',action:'inspect',target:'clean nano kk',environmentId:'4d0aab59-43ec-ecf1-a9d1-869f2517adbb',instruction:'Inspect app read only'};
const options={approvedTargets:['clean nano kk']};
test('CNAI request creates nonexecuting handoff',()=>{
 const r=prepareHandoff(input,options);
 assert.equal(r.status,'READY_FOR_VERIFIED_TRANSPORT');
 assert.equal(r.payload.executionAllowed,false);
 assert.equal(r.payload.requiresHumanApproval,true);
 assert.equal(r.digest.length,64);
});
test('write and publish requests are rejected',()=>{
 for(const action of ['publish','save','delete','execute']) assert.throws(()=>prepareHandoff({...input,action},options),/read_only/);
});
test('unknown origin or target is rejected',()=>{
 assert.throws(()=>prepareHandoff({...input,origin:'other'},options),/origin/);
 assert.throws(()=>prepareHandoff({...input,target:'unknown'},options),/target/);
});
