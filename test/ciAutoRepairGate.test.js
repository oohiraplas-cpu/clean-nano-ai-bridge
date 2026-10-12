const test = require('node:test');
const assert = require('node:assert/strict');
const { assessCiAutoRepair } = require('../src/ciAutoRepairGate');
const base = {
  branch: 'draft/vnext-automation-gates-20261012', headSha: 'a'.repeat(40),
  workflowEvent: 'pull_request', conclusion: 'failure',
  failedJobs: ['test'], changedFiles: ['test/server.test.js'], attempt: 0,
  evidence: { failureLogReviewed: true, rootCauseVerified: true, backupVerified: true,
    diffReviewed: true, testPlanVerified: true, humanApprovalForDraftEdit: true }
};
test('only a narrowly verified draft repair candidate is permitted', () => {
  assert.deepEqual(assessCiAutoRepair(base), {
    status: 'draft_repair_candidate', mayEditDraft: true, mayDeploy: false, mayMerge: false, maxAttempts: 2
  });
});
test('CI success never triggers a repair', () => {
  assert.equal(assessCiAutoRepair({...base, conclusion: 'success'}).status, 'no_repair_needed');
});
test('unknown, running and cancelled CI fail closed', () => {
  for (const conclusion of [undefined, 'cancelled', 'timed_out', 'in_progress']) {
    assert.equal(assessCiAutoRepair({...base, conclusion}).status, 'blocked');
  }
});
test('main, missing SHA and untrusted events fail closed', () => {
  for (const patch of [{branch:'main'}, {headSha:'short'}, {workflowEvent:'workflow_dispatch'}]) {
    assert.equal(assessCiAutoRepair({...base,...patch}).mayEditDraft, false);
  }
});
test('multiple failed jobs, broad or unsafe changes and excessive retries block', () => {
  for (const patch of [{failedJobs:['test','deploy']}, {changedFiles:['.github/workflows/deploy.yml']},
    {changedFiles:['src/../../main.js']}, {changedFiles:[]}, {attempt:2}]) {
    assert.equal(assessCiAutoRepair({...base,...patch}).status, 'blocked');
  }
});
test('no draft modification without human approval and independent review', () => {
  for (const key of Object.keys(base.evidence)) {
    assert.equal(assessCiAutoRepair({...base,evidence:{...base.evidence,[key]:false}}).status,'blocked');
  }
});
