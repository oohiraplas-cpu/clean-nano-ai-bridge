'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Design-only policy contract. No SharePoint I/O, app mutation or privilege grants.
// Administrative status is authoritative only after an independent, unique lookup.
function decideAccess({ identityVerified, myDataRecords, registrationSaved, adminLookup = null, entitlementVerified = false }) {
  if (identityVerified !== true || !Array.isArray(myDataRecords) || myDataRecords.length > 1) return 'DENY';
  if (myDataRecords.length === 0) return 'ONBOARDING_ONLY';
  const record = myDataRecords[0];
  if (!record || record.ownerVerified !== true || record.requiredFieldsComplete !== true || registrationSaved !== true) return 'ONBOARDING_ONLY';
  if (!adminLookup || adminLookup.verified !== true || adminLookup.unique !== true) return 'DENY';
  if (adminLookup.status !== 'NONE' && adminLookup.status !== 'APPROVED') return 'DENY';
  // Auto-approval grants BASIC access only. Privileged entitlements are separate.
  return entitlementVerified === true ? 'BASIC_AND_VERIFIED_ENTITLEMENTS' : 'BASIC_ONLY';
}

const record = {ownerVerified:true,requiredFieldsComplete:true};
const approvedLookup = {verified:true,unique:true,status:'APPROVED'};
const base = {identityVerified:true,myDataRecords:[record],registrationSaved:true,adminLookup:approvedLookup};
test('unregistered verified user is onboarding-only',()=>assert.equal(decideAccess({...base,myDataRecords:[],registrationSaved:false}), 'ONBOARDING_ONLY'));
test('failed identity, failed lookup and duplicate records fail closed',()=>{
  assert.equal(decideAccess({...base,identityVerified:false}), 'DENY');
  for(const x of [null,undefined,[record,record]]) assert.equal(decideAccess({...base,myDataRecords:x}), 'DENY');
});
test('incomplete form or missing persisted save cannot auto approve',()=>{
  assert.equal(decideAccess({...base,myDataRecords:[{ownerVerified:true,requiredFieldsComplete:false}]}), 'ONBOARDING_ONLY');
  assert.equal(decideAccess({...base,registrationSaved:false}), 'ONBOARDING_ONLY');
});
test('verified registration auto-approves basic use without privileged entitlement',()=>assert.equal(decideAccess(base), 'BASIC_ONLY'));
test('verified independent entitlement can unlock its own functions',()=>assert.equal(decideAccess({...base,entitlementVerified:true}), 'BASIC_AND_VERIFIED_ENTITLEMENTS'));
test('administrator suspension and revocation override auto approval',()=>{
  for(const status of ['SUSPENDED','REVOKED']) assert.equal(decideAccess({...base,adminLookup:{...approvedLookup,status}}),'DENY');
});
test('unverified admin override and unknown status fail closed',()=>{
  assert.equal(decideAccess({...base,adminLookup:{...approvedLookup,verified:false}}),'DENY');
  assert.equal(decideAccess({...base,adminLookup:{...approvedLookup,status:'UNKNOWN'}}),'DENY');
});
test('verified administrator reapproval restores basic access only',()=>assert.equal(decideAccess({...base,adminLookup:approvedLookup}),'BASIC_ONLY'));
test('missing admin lookup fails closed',()=>{
  for(const adminLookup of [null,undefined]) assert.equal(decideAccess({...base,adminLookup}),'DENY');
});
test('failed admin lookup fails closed',()=>assert.equal(decideAccess({...base,adminLookup:{...approvedLookup,verified:false}}),'DENY'));
test('non-unique admin lookup fails closed',()=>assert.equal(decideAccess({...base,adminLookup:{...approvedLookup,unique:false}}),'DENY'));
test('unknown admin state fails closed',()=>assert.equal(decideAccess({...base,adminLookup:{...approvedLookup,status:'PENDING'}}),'DENY'));
test('verified absence of blocking override allows basic access',()=>assert.equal(decideAccess({...base,adminLookup:{verified:true,unique:true,status:'NONE'}}),'BASIC_ONLY'));
