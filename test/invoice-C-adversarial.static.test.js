'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
function reserve({partnerKey,laborKey,requestId,serverUnique,claimState}){
 if(!partnerKey||!laborKey||!requestId||serverUnique!==true)return 'DENY';
 if(!claimState)return 'CREATE';
 if(claimState.partnerKey!==partnerKey||claimState.laborKey!==laborKey)return 'DENY';
 if(claimState.requestId===requestId&&claimState.status==='Committed')return 'IDEMPOTENT_READ';
 return 'CONFLICT';
}
const b={partnerKey:'p1',laborKey:'L1',requestId:'r1',serverUnique:true,claimState:null};
test('C create only when server uniqueness is guaranteed',()=>assert.equal(reserve(b),'CREATE'));
test('C reject missing server uniqueness',()=>assert.equal(reserve({...b,serverUnique:false}),'DENY'));
test('C reject concurrent other request',()=>assert.equal(reserve({...b,claimState:{partnerKey:'p1',laborKey:'L1',requestId:'r2',status:'Reserved'}}),'CONFLICT'));
test('C committed same request is read-only retry',()=>assert.equal(reserve({...b,claimState:{partnerKey:'p1',laborKey:'L1',requestId:'r1',status:'Committed'}}),'IDEMPOTENT_READ'));
test('C rejected reused request id on different labor key',()=>assert.equal(reserve({...b,claimState:{partnerKey:'p1',laborKey:'L2',requestId:'r1',status:'Committed'}}),'DENY'));
test('C reject missing request id',()=>assert.equal(reserve({...b,requestId:''}),'DENY'));
