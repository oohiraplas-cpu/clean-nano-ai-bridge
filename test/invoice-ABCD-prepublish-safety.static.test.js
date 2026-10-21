'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
// Offline design contract only. No real ACL, transactions or PDF are exercised.
function issueAllowed({identity,member,partnerKey,issuedAt,rateVersion}){
 return Boolean(identity?.verified&&identity.objectId&&member?.approved&&member.objectId===identity.objectId&&member.partnerKey===partnerKey&&Number.isInteger(issuedAt)&&issuedAt>=member.from&&issuedAt<member.to&&rateVersion?.approved&&rateVersion.partnerKey===partnerKey&&issuedAt>=rateVersion.from&&issuedAt<rateVersion.to);
}
function invoiceSnapshot({partnerKey,rateVersion,issuedAt}){
 if(!partnerKey||!rateVersion?.approved||rateVersion.partnerKey!==partnerKey||!Number.isInteger(issuedAt)||issuedAt<rateVersion.from||issuedAt>=rateVersion.to||!Number.isSafeInteger(rateVersion.rateYen))return null;
 return Object.freeze({partnerKey,rateVersionKey:rateVersion.key,rateYen:rateVersion.rateYen,issuedAt});
}
function recover({requestId,claim,invoicePersisted,pdfPersisted}){
 if(!requestId||!claim||claim.requestId!==requestId)return 'DENY';
 if(claim.status==='Committed'&&invoicePersisted&&pdfPersisted)return 'IDEMPOTENT_READ';
 if(claim.status==='Reserved'&&!invoicePersisted&&!pdfPersisted)return 'RETRY_SAME_REQUEST';
 return 'HUMAN_REVIEW'; // partial failure: no auto-release or silent overwrite
}
function pdfPayload({registeredActiveWorkers,verified,rateYen,subtotalYen,taxYen,totalYen}){
 if(!verified||!Number.isInteger(registeredActiveWorkers)||registeredActiveWorkers<1||![subtotalYen,taxYen,totalYen].every(x=>typeof x==='string'&&/^\d+$/.test(x))||BigInt(subtotalYen)+BigInt(taxYen)!==BigInt(totalYen))return null;
 const result={registeredActiveWorkers,subtotalYen,taxYen,totalYen,metadata:{kind:'invoice'}};
 if(registeredActiveWorkers===1){if(!Number.isSafeInteger(rateYen))return null;result.taxExclusiveRateYen=rateYen;}
 return result;
}
const member={approved:true,objectId:'u1',partnerKey:'p1',from:100,to:200};
const identity={verified:true,objectId:'u1'};
const rate={approved:true,partnerKey:'p1',key:'v1',rateYen:12345,from:100,to:200};
const base={identity,member,partnerKey:'p1',issuedAt:150,rateVersion:rate};
test('A valid membership at issue time',()=>assert.equal(issueAllowed(base),true));
test('A membership revoked at issue time stops invoice',()=>assert.equal(issueAllowed({...base,member:{...member,to:150}}),false));
test('A company membership switched stops invoice',()=>assert.equal(issueAllowed({...base,member:{...member,partnerKey:'p2'}}),false));
test('A identity switched stops invoice',()=>assert.equal(issueAllowed({...base,identity:{verified:true,objectId:'u2'}}),false));
test('B rate version snapshot remains immutable after new rate',()=>{const snap=invoiceSnapshot({partnerKey:'p1',rateVersion:rate,issuedAt:150});const newRate={...rate,key:'v2',rateYen:99999,from:200,to:300};assert.equal(snap.rateVersionKey,'v1');assert.equal(snap.rateYen,12345);assert.equal(newRate.rateYen,99999);assert.equal(Object.isFrozen(snap),true)});
test('B expired rate version rejected',()=>assert.equal(invoiceSnapshot({partnerKey:'p1',rateVersion:rate,issuedAt:200}),null));
test('B foreign partner rate rejected',()=>assert.equal(invoiceSnapshot({partnerKey:'p2',rateVersion:rate,issuedAt:150}),null));
test('C fully committed retry returns read-only result',()=>assert.equal(recover({requestId:'r1',claim:{requestId:'r1',status:'Committed'},invoicePersisted:true,pdfPersisted:true}),'IDEMPOTENT_READ'));
test('C clean reservation can retry same request',()=>assert.equal(recover({requestId:'r1',claim:{requestId:'r1',status:'Reserved'},invoicePersisted:false,pdfPersisted:false}),'RETRY_SAME_REQUEST'));
test('C partial PDF persistence requires human review',()=>assert.equal(recover({requestId:'r1',claim:{requestId:'r1',status:'Reserved'},invoicePersisted:true,pdfPersisted:false}),'HUMAN_REVIEW'));
test('C request mismatch rejected',()=>assert.equal(recover({requestId:'r2',claim:{requestId:'r1',status:'Committed'},invoicePersisted:true,pdfPersisted:true}),'DENY'));
const pdf={registeredActiveWorkers:2,verified:true,rateYen:987654,subtotalYen:'10000',taxYen:'1000',totalYen:'11000'};
test('D two workers omit unit price in payload and metadata',()=>{const v=pdfPayload(pdf);assert.equal(Object.hasOwn(v,'taxExclusiveRateYen'),false);assert.equal(JSON.stringify(v).includes('987654'),false);assert.equal(JSON.stringify(v.metadata).includes('987654'),false)});
test('D one worker includes tax exclusive unit price',()=>assert.equal(pdfPayload({...pdf,registeredActiveWorkers:1}).taxExclusiveRateYen,987654));
test('D unverified PDF rejected',()=>assert.equal(pdfPayload({...pdf,verified:false}),null));
test('D inconsistent totals rejected',()=>assert.equal(pdfPayload({...pdf,totalYen:'11001'}),null));
