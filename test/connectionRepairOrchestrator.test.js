'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeConnectionRequest } = require('../src/connectionRepairOrchestrator');

test('diagnose uses the read-only existing diagnostic', () => {
  assert.equal(executeConnectionRequest({ service: 'bridgeMcp', operation: 'diagnose', status: 401, endpointPath: '/mcp' }).reason, 'unauthorized');
});
test('repair without scoped approval is rejected', () => {
  assert.equal(executeConnectionRequest({ service: 'azure', operation: 'repair' }).status, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(executeConnectionRequest({ service: 'azure', operation: 'repair', approved: true }).status, 'HUMAN_APPROVAL_REQUIRED');
});
test('approved repair with no adapter fails closed', () => {
  assert.equal(executeConnectionRequest({ service: 'azure', operation: 'repair', approved: true, approvalScope: 'connection_repair' }).reason, 'provider_adapter_unavailable');
});
test('unverified or mutating adapter cannot be executed', () => {
  const request = { service: 'azure', operation: 'repair', approved: true, approvalScope: 'connection_repair' };
  assert.equal(executeConnectionRequest(request, { azure: { diagnose: () => ({ verified: false, safeAction: 'read_only_check' }) } }).status, 'BLOCKED');
  assert.equal(executeConnectionRequest(request, { azure: { diagnose: () => ({ verified: true, safeAction: 'rotate_secret' }) } }).reason, 'mutation_adapter_not_approved');
});
test('approved rotation remains a plan, never writes credentials', () => {
  const result = executeConnectionRequest({ service: 'copilotStudio', operation: 'rotate', approved: true, approvalScope: 'connection_repair', secret: 'NEVER_LOG_ME' });
  assert.equal(result.status, 'HUMAN_APPROVAL_REQUIRED');
  assert.doesNotMatch(JSON.stringify(result), /NEVER_LOG_ME/);
});
test('diagnostic adapter exception is safely classified', () => {
  const result = executeConnectionRequest({ service: 'azure', operation: 'repair', approved: true, approvalScope: 'connection_repair' }, { azure: { diagnose: () => { throw Error('secret leakage'); } } });
  assert.equal(result.reason, 'provider_diagnosis_failed');
  assert.doesNotMatch(JSON.stringify(result), /secret leakage/);
});
