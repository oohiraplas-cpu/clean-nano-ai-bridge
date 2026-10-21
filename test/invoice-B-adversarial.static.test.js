'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
function price({partnerKey,version,asOf,unitsMilli,taxBasisPoints,rounding}){
 if(!partnerKey||!version?.approved||version.partnerKey!==partnerKey||!Number.isInteger(asOf)||!Number.isInteger(version.from)||!Number.isInteger(version.to)||asOf<version.from||asOf>=version.to||!Number.isSafeInteger(version.rateYen)||version.rateYen<0||!Number.isSafeInteger(unitsMilli)||unitsMilli<0||!Number.isInteger(taxBasisPoints)||taxBasisPoints<0||rounding!=='floor')return null;
 const numerator=BigInt(version.rateYen)*BigInt(unitsMilli);
 const subtotal=numerator/1000n;
 const tax=subtotal*BigInt(taxBasisPoints)/10000n;
 return {subtotal:subtotal.toString(),tax:tax.toString(),total:(subtotal+tax).toString()};
}
const b={partnerKey:'p1',version:{approved:true,partnerKey:'p1',from:100,to:200,rateYen:22000},asOf:150,unitsMilli:1500,taxBasisPoints:1000,rounding:'floor'};
test('B fractional 1.5 labor units',()=>assert.deepEqual(price(b),{subtotal:'33000',tax:'3300',total:'36300'}));
test('B wrong partner denied',()=>assert.equal(price({...b,partnerKey:'p2'}),null));
test('B expired rate denied',()=>assert.equal(price({...b,asOf:200}),null));
test('B unapproved rate denied',()=>assert.equal(price({...b,version:{...b.version,approved:false}}),null));
test('B unknown rounding denied',()=>assert.equal(price({...b,rounding:null}),null));
test('B negative labor denied',()=>assert.equal(price({...b,unitsMilli:-1}),null));
