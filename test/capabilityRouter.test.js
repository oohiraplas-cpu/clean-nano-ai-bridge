'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildRegistry,route,operation,classify} = require('../src/capabilityRouter');
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
  assert.equal(route(r,'update_powerapps_app',{}, {authenticated:true,permitted:true,humanApprovalVerified:true},handlers).status,'ok');
});
