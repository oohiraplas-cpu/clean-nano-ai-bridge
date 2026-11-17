'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { planEntraOnboarding } = require('../src/entraOnboardingGate');

const id = '11111111-1111-4111-8111-111111111111';
const req = { requestId:id, displayName:'テスト社員', email:'worker@example.com', category:'社員', employeeId:'EMP-001' };
const ev = {
  source:'trusted_server', tenantVerified:true, requestId:id,
  approval:{verified:true, requestId:id, authorizedApprover:true, revoked:false},
  duplicateCheck:{complete:true, atomicGuard:true, matched:false},
  graphPermissionVerified:true, policyVerified:true, costVerifiedNoNewCharge:true,
  existingIdentityReconciled:true, targetEmail:'worker@example.com'
};
test('approved member returns non-executable plan', () => {
  const r = planEntraOnboarding(req, ev);
  assert.equal(r.status, 'READY_FOR_AUTHORIZED_EXECUTOR');
  assert.equal(r.operation, 'graph_manage.user_create');
  assert.equal(r.canWrite, false);
});
test('approved contractor chooses guest invitation', () => {
  const r = planEntraOnboarding({...req, category:'協力会社', employeeId:undefined}, ev);
  assert.equal(r.operation, 'entra_invite_user');
});
for (const [name, evidence] of [
  ['no approval', {...ev, approval:undefined}],
  ['forged source', {...ev, source:'powerapps_client'}],
  ['wrong request', {...ev, requestId:'different'}],
  ['revoked approval', {...ev, approval:{...ev.approval, revoked:true}}],
  ['wrong approver', {...ev, approval:{...ev.approval, authorizedApprover:false}}],
  ['incomplete duplicate check', {...ev, duplicateCheck:{complete:false, atomicGuard:true, matched:false}}],
  ['non-atomic check', {...ev, duplicateCheck:{complete:true, atomicGuard:false, matched:false}}],
  ['duplicate found', {...ev, duplicateCheck:{complete:true, atomicGuard:true, matched:true}}],
  ['missing graph permissions', {...ev, graphPermissionVerified:false}],
  ['unverified costs', {...ev, costVerifiedNoNewCharge:false}],
  ['identity not reconciled', {...ev, existingIdentityReconciled:false}],
  ['wrong email', {...ev, targetEmail:'different@example.com'}]
]) {
  test('fail closed: '+name, () => {
    const r = planEntraOnboarding(req, evidence);
    assert.equal(r.status, 'BLOCKED');
    assert.equal(r.canWrite, false);
  });
}
test('invalid member employee ID is denied', () => assert.equal(planEntraOnboarding({...req, employeeId:''}, ev).status,'BLOCKED'));
test('unknown category is denied', () => assert.equal(planEntraOnboarding({...req, category:'other'}, ev).status,'BLOCKED'));
