'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
function allow({objectId,membership,partner,asOf}){
 if(!objectId||!membership||!membership.approved||membership.objectId!==objectId||membership.partnerKey!==partner?.key||partner?.active!==true||!Number.isInteger(asOf)||!Number.isInteger(membership.from)||!Number.isInteger(membership.to)||asOf<membership.from||asOf>=membership.to)return false;
 return true;
}
const b={objectId:'u1',membership:{approved:true,objectId:'u1',partnerKey:'p1',from:100,to:200},partner:{key:'p1',active:true},asOf:150};
test('A valid approved membership',()=>assert.equal(allow(b),true));
test('A foreign partner denied',()=>assert.equal(allow({...b,partner:{key:'p2',active:true}}),false));
test('A unapproved membership denied',()=>assert.equal(allow({...b,membership:{...b.membership,approved:false}}),false));
test('A expired membership denied',()=>assert.equal(allow({...b,asOf:200}),false));
test('A future membership denied',()=>assert.equal(allow({...b,asOf:99}),false));
test('A absent identity denied',()=>assert.equal(allow({...b,objectId:null}),false));
