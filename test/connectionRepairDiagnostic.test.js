'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseConnection, rotationPlan } = require('../src/connectionRepairDiagnostic');

test('unauthorized does not disclose secret or claim recovery', () => {
  const result = diagnoseConnection({service:'bridgeMcp',status:401,configured:true,endpointPath:'/mcp',apiKey:'DO_NOT_ECHO'});
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.reason,'unauthorized');
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_ECHO/);
});
test('endpoint mismatch fails closed', () => {
  assert.equal(diagnoseConnection({service:'bridgeConnector',status:200,endpointPath:'/mcp'}).status,'BLOCKED');
});
test('missing configuration fails closed', () => {
  assert.equal(diagnoseConnection({service:'bridgeMcp',configured:false,status:200}).status,'BLOCKED');
});
test('unverified responses never pass', () => {
  assert.equal(diagnoseConnection({service:'azure',status:201}).status,'BLOCKED');
  assert.equal(diagnoseConnection({service:'unknown',status:200}).status,'BLOCKED');
});
test('a successful HTTP response only requests authorized-operation verification', () => {
  const result = diagnoseConnection({service:'bridgeMcp',status:200,endpointPath:'/mcp'});
  assert.equal(result.nextAction,'verify_authorized_operation');
});
test('rotation is a non-mutating approval-gated plan', () => {
  const plan = rotationPlan('copilotStudio');
  assert.equal(plan.status,'HUMAN_APPROVAL_REQUIRED');
  assert.equal(plan.steps.includes('revoke_old_credential_after_verified_cutover'),true);
});
