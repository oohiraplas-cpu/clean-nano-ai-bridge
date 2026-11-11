const test = require('node:test');
const assert = require('node:assert/strict');
const { assessCiRepairCandidate } = require('../src/ciRepairCandidate');
const job = { id: 123, name: 'test', status: 'completed', conclusion: 'failure' };
const base = { run: { status: 'completed', conclusion: 'failure' }, jobs: [job],
  branch: 'draft/vnext-automation-gates-20261012', headSha: 'a'.repeat(40),
  workflowEvent: 'pull_request', changedFiles: ['test/server.test.js'], attempt: 0 };
test('CI success yields no repair and no log requests', () => {
  const result = assessCiRepairCandidate({...base, run: {status:'completed',conclusion:'success'},
    jobs: [{...job,conclusion:'success'}]});
  assert.equal(result.status,'no_repair_needed');
  assert.deepEqual(result.logJobIds,[]);
  assert.equal(result.mayEditDraft,false);
});
test('CI failure returns the failed job ID for manual log review, but blocks writing', () => {
  const result = assessCiRepairCandidate(base);
  assert.equal(result.status,'blocked');
  assert.deepEqual(result.logJobIds,[123]);
  assert.equal(result.mayEditDraft,false);
  assert.equal(result.mayDeploy,false);
  assert.equal(result.mayMerge,false);
});
test('verified failure evidence and explicit draft approval only permit a candidate', () => {
  const result = assessCiRepairCandidate({...base,evidence: {
    failureLogReviewed:true,rootCauseVerified:true,backupVerified:true,diffReviewed:true,
    testPlanVerified:true,humanApprovalForDraftEdit:true
  }});
  assert.equal(result.status,'draft_repair_candidate');
  assert.equal(result.mayEditDraft,true);
  assert.equal(result.mayDeploy,false);
  assert.equal(result.mayMerge,false);
});
test('incomplete and contradictory CI data fail closed', () => {
  for (const patch of [{run:{status:'in_progress',conclusion:null}},
    {run:{status:'completed',conclusion:'success'}},
    {jobs:[{...job,id:'not-a-job-id'}]},
    {jobs:[job,{...job,id:124}]}]) {
    const result = assessCiRepairCandidate({...base,...patch});
    assert.equal(result.status,'blocked');
    assert.equal(result.mayEditDraft,false);
  }
});
test('main is never eligible even with approved evidence', () => {
  const result = assessCiRepairCandidate({...base,branch:'main',evidence:{
    failureLogReviewed:true,rootCauseVerified:true,backupVerified:true,diffReviewed:true,
    testPlanVerified:true,humanApprovalForDraftEdit:true
  }});
  assert.equal(result.mayEditDraft,false);
});
