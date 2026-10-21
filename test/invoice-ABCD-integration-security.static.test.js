'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
// Offline contract tests: do not touch SharePoint, flows, invoices, or real PDFs.
function authorize({identity,member,partnerKey,asOf}) {
 return Boolean(identity?.verified&&identity.objectId&&member?.approved&&member.objectId===identity.objectId&&member.partnerKey===partnerKey&&Number.isInteger(asOf)&&Number.isInteger(member.from)&&Number.isInteger(member.to)&&asOf>=member.from&&asOf<member.to);
}
function calculate({rateYen,unitsMilli,taxBasisPoints,rounding}) {
 if(!Number.isSafeInteger(rateYen)||rateYen<0||!Number.isSafeInteger(unitsMilli)||unitsMilli<0||!Number.isInteger(taxBasisPoints)||taxBasisPoints<0||rounding!=='floor')return null;
 const subtotal=BigInt(rateYen)*BigInt(unitsMilli)/1000n;
 const tax=subtotal*BigInt(taxBasisPoints)/10000n;
 return {subtotalYen:subtotal.toString(),taxYen:tax.toString(),totalYen:(subtotal+tax).toString()};
}
function claim({key,requestId,serverUnique,stored}) {
 if(!key||!requestId||serverUnique!==true)return 'DENY';
 if(!stored)return 'CREATE_ATTEMPT';
 if(stored.key!==key)return 'DENY';
 return stored.requestId===requestId&&stored.status==='Committed'?'IDEMPOTENT_READ':'CONFLICT';
}
function safePdfModel({registeredActiveWorkers,verified,subtotalYen,taxYen,totalYen,rateYen}) {
 if(!verified||!Number.isInteger(registeredActiveWorkers)||registeredActiveWorkers<1||![subtotalYen,taxYen,totalYen].every(x=>typeof x==='string'&&/^\d+$/.test(x))||BigInt(subtotalYen)+BigInt(taxYen)!==BigInt(totalYen))return null;
 if(registeredActiveWorkers===1){if(!Number.isSafeInteger(rateYen)||rateYen<0)return null;return {registeredActiveWorkers,subtotalYen,taxYen,totalYen,rateYen};}
 return {registeredActiveWorkers,subtotalYen,taxYen,totalYen}; // no rate key whatsoever
}
const id={verified:true,objectId:'u1'},member={approved:true,objectId:'u1',partnerKey:'p1',from:100,to:200};
const p={registeredActiveWorkers:2,verified:true,subtotalYen:'33000',taxYen:'3300',totalYen:'36300',rateYen:22000};
test('identity and membership verified',()=>assert.equal(authorize({identity:id,member,partnerKey:'p1',asOf:150}),true));
test('identity revoked at invoice time rejected',()=>assert.equal(authorize({identity:id,member:{...member,to:150},partnerKey:'p1',asOf:150}),false));
test('identity changed to another person rejected',()=>assert.equal(authorize({identity:{...id,objectId:'u2'},member,partnerKey:'p1',asOf:150}),false));
test('partner switched between request and issue rejected',()=>assert.equal(authorize({identity:id,member,partnerKey:'p2',asOf:150}),false));
test('fractional labor rounds subtotal to integer yen',()=>assert.deepEqual(calculate({rateYen:1001,unitsMilli:1500,taxBasisPoints:1000,rounding:'floor'}),{subtotalYen:'1501',taxYen:'150',totalYen:'1651'}));
test('unapproved rounding rejected',()=>assert.equal(calculate({rateYen:1001,unitsMilli:1500,taxBasisPoints:1000,rounding:'nearest'}),null));
test('missing atomic uniqueness rejects reservation',()=>assert.equal(claim({key:'p1:L1',requestId:'r1',serverUnique:false}), 'DENY'));
test('concurrent competing request returns conflict',()=>assert.equal(claim({key:'p1:L1',requestId:'r2',serverUnique:true,stored:{key:'p1:L1',requestId:'r1',status:'Reserved'}}),'CONFLICT'));
test('same committed request returns idempotent read',()=>assert.equal(claim({key:'p1:L1',requestId:'r1',serverUnique:true,stored:{key:'p1:L1',requestId:'r1',status:'Committed'}}),'IDEMPOTENT_READ'));
test('multiple-worker PDF model omits rate property',()=>{const v=safePdfModel(p);assert.equal(Object.hasOwn(v,'rateYen'),false);assert.equal(JSON.stringify(v).includes('22000'),false)});
test('one-worker PDF model includes rate property',()=>assert.equal(safePdfModel({...p,registeredActiveWorkers:1}).rateYen,22000));
test('unverified PDF model rejected',()=>assert.equal(safePdfModel({...p,verified:false}),null));
test('inconsistent invoice totals rejected',()=>assert.equal(safePdfModel({...p,totalYen:'36301'}),null));
