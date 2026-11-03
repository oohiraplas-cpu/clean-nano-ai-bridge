'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareHandoff}=require('../src/lv5CnaiHandoff');
const {createHandoffLedger}=require('../src/lv5HandoffLedger');
const req={requestId:'cnai_req_001',origin:'CNAI',action:'inspect',target:'clean nano kk',environmentId:'4d0aab59-43ec-ecf1-a9d1-869f2517adbb',instruction:'read only'};
const opts={approvedTargets:['clean nano kk']};
test('handoff ledger accepts once and never delivers',()=>{
 const l=createHandoffLedger(),h=prepareHandoff(req,opts);
 assert.equal(l.accept(h).delivered,false);
 assert.equal(l.accept(h).status,'DUPLICATE');
 assert.equal(l.status(req.requestId),'PENDING_VERIFIED_TRANSPORT');
});
test('same ID with changed content is rejected as conflict',()=>{
 const l=createHandoffLedger();
 l.accept(prepareHandoff(req,opts));
 assert.equal(l.accept(prepareHandoff({...req,instruction:'changed'},opts)).status,'CONFLICT');
});
test('unsafe payload fails closed',()=>{
 assert.throws(()=>createHandoffLedger().accept({status:'READY_FOR_VERIFIED_TRANSPORT',digest:'a'.repeat(64),payload:{requestId:'x',executionAllowed:true,requiresHumanApproval:true}}),/unsafe/);
});
