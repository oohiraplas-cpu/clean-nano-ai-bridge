'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Design-only policy contract. No SharePoint I/O, app mutation or privilege grants.
// Administrative overrides are authoritative only when independently verified.
function decideAccess({ identityVerified, myDataRecords, registrationSaved, adminOverride = null, entitlementVerified = false }) {
  if (identityVerified !== true || !Array.isArray(myDataRecords) || myDataRecords.length > 1) return 'DENY';
  if (myDataRecords.length === 0) return 'ONBOARDING_ONLY';
  const record = myDataRecords[0];
  if (!record || record.ownerVerified !== true || record.requiredFieldsComplete !== true || registrationSaved !== true) return 'ONBOARDING_ONLY';
  if (adminOverride !== null && adminOverride !== undefined) {
    if (adminOverride.verified !== true) return 'DENY';
    if (adminOverride.status === 'SUSPENDED' || adminOverride.status === 'REVOKED') return 'DENY';
    if (adminOverride.status !== 'APPROVED') return 'DENY';
  }
  // Auto-approval grants BASIC access only. Privileged entitlements are separate.
  return entitlementVerified === true ? 'BASIC_AND_VERIFIED_ENTITLEMENTS' : 'BASIC_ONLY';
}

const record = {ownerVerified:true,requiredFieldsComplete:true};
const base = {identityVerified:true,myDataRecords:[record],registrationSaved:true};
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
  for(const status of ['SUSPENDED','REVOKED']) assert.equal(decideAccess({...base,adminOverride:{verified:true,status}}),'DENY');
});
test('unverified admin override and unknown status fail closed',()=>{
  assert.equal(decideAccess({...base,adminOverride:{verified:false,status:'APPROVED'}}),'DENY');
  assert.equal(decideAccess({...base,adminOverride:{verified:true,status:'UNKNOWN'}}),'DENY');
});
test('verified administrator reapproval restores basic access only',()=>assert.equal(decideAccess({...base,adminOverride:{verified:true,status:'APPROVED'}}),'BASIC_ONLY'));
