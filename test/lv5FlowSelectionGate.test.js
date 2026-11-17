'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {selectFlowByGuid,selectFlowByName}=require('../src/lv5FlowSelectionGate');
const environmentId='4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const a='de581cc8-1dca-f111-a05c-002248f083f2',b='e69bdfdd-7cca-f111-a05c-002248f083f2';
const flows=[{id:a,name:'CN_E2E_Test_Flow',state:'on'},{id:b,name:'CN_E2E_Test_Flow',state:'on'}];
test('duplicate display names cannot select a flow',()=>{
 const r=selectFlowByName(flows,{name:'CN_E2E_Test_Flow'});
 assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'ambiguous_flow_name');
});
test('GUID allowlist selects exact ID but never authorizes execution',()=>{
 const r=selectFlowByGuid(flows,{flowId:a,environmentId,approvedIds:[a]});
 assert.equal(r.status,'DISCOVERED_APPROVED_ID');assert.equal(r.flowId,a);assert.equal(r.executionAllowed,false);
});
test('unapproved, missing and duplicate GUIDs fail closed',()=>{
 assert.equal(selectFlowByGuid(flows,{flowId:b,environmentId,approvedIds:[a]}).status,'BLOCKED');
 assert.equal(selectFlowByGuid([flows[0],flows[0]],{flowId:a,environmentId,approvedIds:[a]}).status,'BLOCKED');
 assert.equal(selectFlowByGuid(flows,{flowId:a,environmentId:'production',approvedIds:[a]}).status,'BLOCKED');
});
