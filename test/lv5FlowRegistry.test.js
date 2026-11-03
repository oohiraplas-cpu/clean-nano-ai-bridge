'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {discoverFlows}=require('../src/lv5FlowRegistry');
const env='4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const id='fd3b862a-6acd-f111-a05c-000d3acf39a0';
test('discovery never grants execution',()=>{
 const r=discoverFlows([{id,name:'CN_日報PDF作成',state:'on'}],{environmentId:env,approvedIds:[id]});
 assert.equal(r[0].registration,'REGISTERED');
 assert.equal(r[0].executionAllowed,false);
});
test('unapproved discovery remains blocked',()=>{
 assert.equal(discoverFlows([{id,name:'flow',state:'on'}],{environmentId:env})[0].registration,'DISCOVERED_UNAPPROVED');
});
test('reject duplicate IDs and invalid environment',()=>{
 assert.throws(()=>discoverFlows([{id},{id}],{environmentId:env}),/duplicate/);
 assert.throws(()=>discoverFlows([{id}],{environmentId:'production'}),/scope/);
});
