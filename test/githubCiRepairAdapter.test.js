const test = require('node:test');
const assert = require('node:assert/strict');
const { assessGitHubCiRepair } = require('../src/githubCiRepairAdapter');
const sha = 'a'.repeat(40), branch = 'draft/vnext-automation-gates-20261012';
const run = { id: 44, head_sha: sha, head_branch: branch, event: 'pull_request', status: 'completed', conclusion: 'success' };
const job = { id: 123, run_id: 44, head_sha: sha, name: 'test', status: 'completed', conclusion: 'success' };
const base = { workflowRun: run, jobResponse: {total_count:1,jobs:[job]}, expectedHeadSha:sha, branch };
test('completed success never triggers a repair', () => {
  const result = assessGitHubCiRepair(base);
  assert.equal(result.status,'no_repair_needed');
  assert.deepEqual(result.logJobIds,[]);
  assert.equal(result.mayEditDraft,false);
});
test('failed job provides only a log review candidate without approval', () => {
  const result = assessGitHubCiRepair({...base,
    workflowRun:{...run,conclusion:'failure'},
    jobResponse:{total_count:1,jobs:[{...job,conclusion:'failure'}]}});
  assert.equal(result.status,'blocked');
  assert.deepEqual(result.logJobIds,[123]);
  assert.equal(result.mayEditDraft,false);
  assert.equal(result.mayDeploy,false);
  assert.equal(result.mayMerge,false);
});
test('incomplete job pages, wrong SHA and wrong run id fail closed', () => {
  for (const patch of [
    {jobResponse:{total_count:2,jobs:[job]}},
    {workflowRun:{...run,head_sha:'b'.repeat(40)}},
    {jobResponse:{total_count:1,jobs:[{...job,run_id:45}]}},
    {branch:'main'},
    {workflowRun:{...run,status:'in_progress',conclusion:null}}
  ]) {
    const result=assessGitHubCiRepair({...base,...patch});
    assert.equal(result.status,'blocked');
    assert.equal(result.mayEditDraft,false);
  }
});
test('no automatic edit even with matching failed metadata unless approved', () => {
  const result = assessGitHubCiRepair({...base,
    workflowRun:{...run,conclusion:'failure'},
    jobResponse:{total_count:1,jobs:[{...job,conclusion:'failure'}]},
    changedFiles:['test/server.test.js'],
    evidence:{failureLogReviewed:true,rootCauseVerified:true,backupVerified:true,diffReviewed:true,testPlanVerified:true}
  });
  assert.equal(result.mayEditDraft,false);
});
