'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
function validateClaim({partnerKey,laborKeys,existingClaims,atomicUniqueEnforced}){
 if(!partnerKey||!Array.isArray(laborKeys)||laborKeys.length===0||laborKeys.some(x=>!x)||new Set(laborKeys).size!==laborKeys.length||!Array.isArray(existingClaims)||atomicUniqueEnforced!==true)return false;
 return laborKeys.every(k=>!existingClaims.some(x=>x.partnerKey===partnerKey&&x.laborKey===k&&x.active===true));
}
const base={partnerKey:'p1',laborKeys:['L1'],existingClaims:[],atomicUniqueEnforced:true};
test('C clean claim passes only with atomic unique enforcement',()=>assert.equal(validateClaim(base),true));
test('C existing active claim rejected',()=>assert.equal(validateClaim({...base,existingClaims:[{partnerKey:'p1',laborKey:'L1',active:true}]}),false));
test('C same request duplicate lines rejected',()=>assert.equal(validateClaim({...base,laborKeys:['L1','L1']}),false));
test('C client-only check rejected',()=>assert.equal(validateClaim({...base,atomicUniqueEnforced:false}),false));
test('C no labor key rejected',()=>assert.equal(validateClaim({...base,laborKeys:[]}),false));
