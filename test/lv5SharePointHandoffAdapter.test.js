'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareHandoff}=require('../src/lv5CnaiHandoff');
const {mapHandoffForReview}=require('../src/lv5SharePointHandoffAdapter');
test('maps only observed existing internal column names without granting writes',()=>{
 const h=prepareHandoff({requestId:'cnai_req_001',origin:'CNAI',action:'inspect',target:'clean nano kk',environmentId:'4d0aab59-43ec-ecf1-a9d1-869f2517adbb',instruction:'read only'},{approvedTargets:['clean nano kk']});
 const m=mapHandoffForReview(h);
 assert.equal(m.writeAllowed,false);
 assert.equal(m.fields.Title,'cnai_req_001');
 assert.equal(m.fields.AIAuditId,h.digest);
 assert.equal(m.fields._x627f__x8a8d__x72b6__x614b_,'承認待ち');
});
test('rejects unsafe handoff',()=>assert.throws(()=>mapHandoffForReview({status:'READY_FOR_VERIFIED_TRANSPORT',digest:'a'.repeat(64),payload:{executionAllowed:true,requiresHumanApproval:true}}),/verified/));
