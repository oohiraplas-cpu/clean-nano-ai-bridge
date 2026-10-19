'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildRegistry,route,operation,operationForCall,classify} = require('../src/capabilityRouter');
test('five MCP categories and conservative unknown classification',()=>{
  assert.equal(classify('get_powerapps_app'),'CN-POWER-MCP');
  assert.equal(classify('get_azure_deployment_metadata'),'CN-CLOUD-MCP');
  assert.equal(classify('verify_github_ci_artifact'),'CN-DEV-MCP');
  assert.equal(classify('get_outlook_messages'),'CN-M365-MCP');
  assert.equal(classify('get_agent_registry'),'CN-AI-MCP');
  assert.equal(operation('unrecognized_tool'),'WRITE');
});
test('preserve all definitions without silent omission',()=>{
  const defs=[{name:'get_powerapps_app',inputSchema:{type:'object'}},{name:'publish_powerapps_app'}];
  const r=buildRegistry(defs);
  assert.equal(r.length,defs.length);
  assert.equal(r[0].action,'READ');
  assert.equal(r[1].action,'PUBLISH');
  assert.equal(r[1].requiresApproval,true);
  assert.throws(()=>buildRegistry([defs[0],defs[0]]),/duplicate/);
});
test('router blocks unknown, unverified auth, permission and approval',()=>{
  const r=buildRegistry([{name:'update_powerapps_app'}]);
  const handlers={update_powerapps_app:()=>({status:'ok'})};
  assert.equal(route(r,'unknown',{}, {},handlers).status,'BLOCKED');
  assert.equal(route(r,'update_powerapps_app',{}, {},handlers).status,'BLOCKED');
  assert.equal(route(r,'update_powerapps_app',{}, {authenticated:true,permitted:true},handlers).status,'BLOCKED');
  assert.equal(route(r,'update_powerapps_app',{}, {authenticated:true,permitted:true,humanApprovalVerified:true,auditReady:true,policyVerified:true,targetVerified:true},handlers).status,'ok');
});

test('side-effecting validation and publish remain gated',()=>{
  assert.equal(operation('validate_powerapps_change'),'EXECUTE');
  assert.equal(operation('powerapps_app_edit_publish'),'PUBLISH');
  assert.equal(classify('unrecognized_tool'),null);
  const r=buildRegistry([{name:'unrecognized_tool'}]);
  assert.equal(route(r,'unrecognized_tool',{}, {authenticated:true,permitted:true,humanApprovalVerified:true,auditReady:true,policyVerified:true,targetVerified:true},{unrecognized_tool:()=>({status:'ok'})}).status,'BLOCKED');
});

test('multiplexed tools enforce actual operation and approval',()=>{
  assert.equal(operationForCall('powerapps_manage',{operation:'publish'}),'PUBLISH');
  assert.equal(operationForCall('sharepoint_manage',{operation:'delete'}),'DELETE');
  assert.equal(operationForCall('powerautomate_manage',{operation:'test'}),'EXECUTE');
  assert.equal(operationForCall('powerapps_manage',{operation:'screen_get'}),'READ');
  assert.equal(operationForCall('powerapps_manage',{}),null);
  const r=buildRegistry([{name:'powerapps_manage'}]);
  const ctx={authenticated:true,permitted:true,auditReady:true,policyVerified:true,targetVerified:true};
  const h={powerapps_manage:()=>({status:'ok'})};
  assert.equal(route(r,'powerapps_manage',{operation:'publish'},ctx,h).status,'BLOCKED');
  assert.equal(route(r,'powerapps_manage',{operation:'screen_get'},ctx,h).status,'ok');
});
