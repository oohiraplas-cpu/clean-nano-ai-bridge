'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

// Pure static contract only. No SharePoint, Power Apps, network, PDF or billing writes.
function evaluateInvoice({identityVerified, membershipVerified, rateVerified, laborConfirmed, storageVerified, taxVerified, rosterCount, laborKeys, previouslyBilledKeys}) {
  if (![identityVerified,membershipVerified,rateVerified,laborConfirmed,storageVerified,taxVerified].every(Boolean)) return {allowed:false};
  if (!Number.isInteger(rosterCount) || rosterCount < 1) return {allowed:false};
  if (!Array.isArray(laborKeys) || laborKeys.length === 0 || laborKeys.some(k => typeof k !== 'string' || !k.trim())) return {allowed:false};
  if (new Set(laborKeys).size !== laborKeys.length) return {allowed:false};
  if (!Array.isArray(previouslyBilledKeys) || laborKeys.some(k=>previouslyBilledKeys.includes(k))) return {allowed:false};
  return {allowed:true,showUnitRate:rosterCount === 1};
}
const valid={identityVerified:true,membershipVerified:true,rateVerified:true,laborConfirmed:true,storageVerified:true,taxVerified:true,rosterCount:1,laborKeys:['L1'],previouslyBilledKeys:[]};
test('one registered worker shows unit rate',()=>assert.deepEqual(evaluateInvoice(valid),{allowed:true,showUnitRate:true}));
test('two or more registered workers hide unit rate',()=>{for(const n of [2,3,10])assert.deepEqual(evaluateInvoice({...valid,rosterCount:n}),{allowed:true,showUnitRate:false})});
test('zero or unknown registered workers fail closed',()=>{for(const n of [0,null,undefined,-1,1.5])assert.equal(evaluateInvoice({...valid,rosterCount:n}).allowed,false)});
test('missing verification always fails closed',()=>{for(const k of ['identityVerified','membershipVerified','rateVerified','laborConfirmed','storageVerified','taxVerified'])assert.equal(evaluateInvoice({...valid,[k]:false}).allowed,false)});
test('duplicate labor keys fail closed',()=>{assert.equal(evaluateInvoice({...valid,laborKeys:['L1','L1']}).allowed,false);assert.equal(evaluateInvoice({...valid,previouslyBilledKeys:['L1']}).allowed,false)});
test('missing labor identifiers fail closed',()=>assert.equal(evaluateInvoice({...valid,laborKeys:[]}).allowed,false));
