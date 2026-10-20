'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Pure policy contract only. No SharePoint reads, writes or Power Apps deployment.
function decideAccess({ identityVerified, myDataRecords, registrationSaved, membershipApproved, entitlementVerified }) {
  if (identityVerified !== true || !Array.isArray(myDataRecords)) return 'DENY';
  if (myDataRecords.length > 1) return 'DENY';
  if (myDataRecords.length === 0) return 'ONBOARDING_ONLY';
  const record = myDataRecords[0];
  if (!record || record.ownerVerified !== true || record.requiredFieldsComplete !== true) return 'ONBOARDING_ONLY';
  if (registrationSaved !== true) return 'ONBOARDING_ONLY';
  if (membershipApproved !== true || entitlementVerified !== true) return 'PENDING_APPROVAL';
  return 'ALLOW';
}

test('new identity is restricted to My Data registration', () => {
  assert.equal(decideAccess({identityVerified:true,myDataRecords:[],registrationSaved:false,membershipApproved:false,entitlementVerified:false}), 'ONBOARDING_ONLY');
});
test('unverified identity, failed lookup and duplicate records deny access', () => {
  for (const records of [null, undefined, [{ownerVerified:true},{ownerVerified:true}]]) {
    assert.equal(decideAccess({identityVerified:true,myDataRecords:records,registrationSaved:true,membershipApproved:true,entitlementVerified:true}), 'DENY');
  }
  assert.equal(decideAccess({identityVerified:false,myDataRecords:[],registrationSaved:true,membershipApproved:true,entitlementVerified:true}), 'DENY');
});
test('form completion without persisted save is insufficient', () => {
  assert.equal(decideAccess({identityVerified:true,myDataRecords:[{ownerVerified:true,requiredFieldsComplete:true}],registrationSaved:false,membershipApproved:true,entitlementVerified:true}), 'ONBOARDING_ONLY');
});
test('self-registration cannot grant membership access', () => {
  assert.equal(decideAccess({identityVerified:true,myDataRecords:[{ownerVerified:true,requiredFieldsComplete:true}],registrationSaved:true,membershipApproved:false,entitlementVerified:true}), 'PENDING_APPROVAL');
});
test('approved and verified existing registrant may proceed', () => {
  assert.equal(decideAccess({identityVerified:true,myDataRecords:[{ownerVerified:true,requiredFieldsComplete:true}],registrationSaved:true,membershipApproved:true,entitlementVerified:true}), 'ALLOW');
});
test('approved membership without verified entitlement is blocked', () => {
  assert.equal(decideAccess({identityVerified:true,myDataRecords:[{ownerVerified:true,requiredFieldsComplete:true}],registrationSaved:true,membershipApproved:true,entitlementVerified:false}), 'PENDING_APPROVAL');
});
