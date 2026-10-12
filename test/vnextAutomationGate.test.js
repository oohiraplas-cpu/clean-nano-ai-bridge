const test = require('node:test');
const assert = require('node:assert/strict');
const { assessAutomationProposal } = require('../src/vnextAutomationGate');

const evidence = {
  backupVerified: true, diffReviewed: true, ciPassed: true,
  appCheckerCriticalZero: true, triggerSafetyVerified: true,
  humanApprovalVerified: true, rollbackVerified: true
};

test('unknown evidence blocks write operations', () => {
  const result = assessAutomationProposal({ platform: 'powerapps', operation: 'publish', targetBranch: 'draft/x' });
  assert.equal(result.allowed, false);
  assert.ok(result.failures.includes('human_approval_unverified'));
  assert.ok(result.failures.includes('app_checker_unverified'));
});
test('explicit complete evidence permits a preflight proposal only', () => {
  assert.deepEqual(assessAutomationProposal({ platform: 'powerapps', operation: 'publish', targetBranch: 'draft/x' }, evidence), { allowed: true, failures: [] });
});
test('main writes, costs and privilege expansion are blocked', () => {
  const result = assessAutomationProposal({ platform: 'bridge', operation: 'update', targetBranch: 'main', additionalCost: true, permissionExpansion: true }, evidence);
  assert.equal(result.allowed, false);
  assert.ok(result.failures.includes('main_write_forbidden'));
  assert.ok(result.failures.includes('additional_cost_forbidden'));
  assert.ok(result.failures.includes('permission_expansion_forbidden'));
});
test('Power Automate changes require trigger safety', () => {
  const result = assessAutomationProposal({ platform: 'powerautomate', operation: 'update', targetBranch: 'draft/x' }, { ...evidence, triggerSafetyVerified: false });
  assert.ok(result.failures.includes('flow_trigger_unverified'));
});
test('publication requires verified rollback and human approval', () => {
  const result = assessAutomationProposal({ platform: 'bridge', operation: 'deploy', targetBranch: 'draft/x' }, { ...evidence, rollbackVerified: false, humanApprovalVerified: false });
  assert.equal(result.allowed, false);
  assert.ok(result.failures.includes('rollback_unverified'));
  assert.ok(result.failures.includes('human_approval_unverified'));
});
