'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRepair } = require('../src/connectionRepairCoordinator');
const capable = {provider:'azure',canWrite:true,canVerify:true,canRollback:true,secureCredentialChannel:true};
const approval = {granted:true,service:'azure',action:'rotate_credential',requestId:'approval-12345',expiresAt:Date.now()+60000};
test('diagnostics remain read-only',()=> {
  const result=evaluateRepair({service:'azure',httpStatus:401});
  assert.equal(result.execution,'read_only');
  assert.equal(result.status,'BLOCKED');
});
test('mutation requires verified provider capability',()=> {
  assert.equal(evaluateRepair({service:'azure',action:'rotate_credential',approval}).reason,'provider_capability_not_verified');
});
test('mutation requires scoped current approval',()=> {
  assert.equal(evaluateRepair({service:'azure',action:'rotate_credential',capability:capable,approval:{...approval,action:'change_permissions'}}).status,'HUMAN_APPROVAL_REQUIRED');
  assert.equal(evaluateRepair({service:'azure',action:'rotate_credential',capability:capable,approval:{...approval,expiresAt:0}}).status,'HUMAN_APPROVAL_REQUIRED');
});
test('approved repair is still not executed without provider adapter',()=> {
  const result=evaluateRepair({service:'azure',action:'rotate_credential',capability:capable,approval,credential:'NEVER_PRINT_THIS'});
  assert.equal(result.execution,'not_executed');
  assert.equal(result.status,'PARTIAL');
  assert.doesNotMatch(JSON.stringify(result),/NEVER_PRINT_THIS/);
});
test('unknown mutations fail closed',()=> {
  assert.equal(evaluateRepair({service:'azure',action:'delete_all',capability:capable,approval}).status,'BLOCKED');
});

test('approval utterance requires trusted pending request and never executes', () => {
  const { resolveApprovalUtterance } = require('../src/connectionRepairCoordinator');
  const pending={source:'trusted_server',status:'pending',presentedToUser:true,requestId:'req-123456',service:'azure',action:'rotate_credential',expiresAt:Date.now()+60000};
  assert.equal(resolveApprovalUtterance('承認する',pending).execution,'not_executed');
  assert.equal(resolveApprovalUtterance('承認する',pending).status,'PARTIAL');
  assert.equal(resolveApprovalUtterance('承認する',{...pending,source:'client'}).status,'BLOCKED');
  assert.equal(resolveApprovalUtterance('承認する',{...pending,expiresAt:0}).status,'BLOCKED');
  assert.equal(resolveApprovalUtterance('はい',pending).status,'HUMAN_APPROVAL_REQUIRED');
});
