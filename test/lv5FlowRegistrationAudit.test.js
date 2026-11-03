'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {auditRegistration}=require('../src/lv5FlowRegistrationAudit');
const environmentId='4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const id='fd3b862a-6acd-f111-a05c-000d3acf39a0',flows=[{id,name:'CN_日報PDF作成',state:'on'}];
test('no Bridge registrations fail closed',()=>{
 const r=auditRegistration({environmentId,flows,registeredIds:[],configuredIds:[]});
 assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'no_registered_flows');
});
test('registration without configuration fails closed',()=>{
 const r=auditRegistration({environmentId,flows,registeredIds:[id],configuredIds:[]});
 assert.equal(r.reason,'registration_configuration_mismatch');
});
test('matching IDs remain non-executable',()=>{
 const r=auditRegistration({environmentId,flows,registeredIds:[id],configuredIds:[id]});
 assert.equal(r.status,'INVENTORY_CONSISTENT');assert.equal(r.executionAllowed,false);
});
test('unknown or duplicate IDs fail closed',()=>{
 assert.equal(auditRegistration({environmentId,flows,registeredIds:[id,id],configuredIds:[id]}).status,'BLOCKED');
 assert.equal(auditRegistration({environmentId,flows,registeredIds:[environmentId],configuredIds:[environmentId]}).status,'BLOCKED');
});
