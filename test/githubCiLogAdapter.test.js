'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {reviewGitHubCiFailure}=require('../src/githubCiLogAdapter');
const sha='a'.repeat(40),branch='draft/vnext-automation-gates-20261012';
const workflowRun={id:44,head_sha:sha,head_branch:branch,event:'pull_request',status:'completed',conclusion:'failure'};
const steps=[{number:1,conclusion:'failure',started_at:'2026-01-01T00:00:02Z',completed_at:'2026-01-01T00:00:03Z'}];
const job={id:123,run_id:44,head_sha:sha,name:'test',status:'completed',conclusion:'failure',steps};
const base={repositoryFullName:'oohiraplas-cpu/clean-nano-ai-bridge',workflowRun,jobResponse:{total_count:1,jobs:[job]},expectedHeadSha:sha,branch};
test('reads only verified failed job and returns non-executable review',async()=>{
  const calls=[];
  const github={fetch_workflow_job_logs:async args=>{calls.push(args);return {result:{content:'2026-01-01T00:00:02Z AssertionError: secret=redacted'}};}};
  const result=await reviewGitHubCiFailure({...base,github});
  assert.deepEqual(calls,[{repo_full_name:base.repositoryFullName,job_id:123}]);
  assert.equal(result.status,'review_required');
  assert.equal(result.candidate.category,'test_failure');
  assert.equal(result.rootCauseVerified,false);
  assert.equal(result.mayEditDraft,false);
  assert.equal(result.mayDeploy,false);
  assert.equal(result.mayMerge,false);
  assert.equal(JSON.stringify(result).includes('secret='),false);
});
test('success never reads logs',async()=>{
  let called=false;
  const github={fetch_workflow_job_logs:async()=>{called=true;throw Error('unexpected');}};
  const result=await reviewGitHubCiFailure({...base,github,workflowRun:{...workflowRun,conclusion:'success'},jobResponse:{total_count:1,jobs:[{...job,conclusion:'success'}]}});
  assert.equal(result.status,'no_repair_needed');
  assert.equal(called,false);
});
test('wrong repository, missing reader and unverified job never fetch',async()=>{
  let called=false;
  const github={fetch_workflow_job_logs:async()=>{called=true;return {result:{content:'AssertionError'}};}};
  const cases=[
    {...base,github,repositoryFullName:'another/repo'},
    {...base,github:null},
    {...base,github,jobResponse:{jobs:[job]}},
    {...base,github,jobResponse:{total_count:1,jobs:[{...job,head_sha:'b'.repeat(40)}]}},
    {...base,github,workflowRun:{...workflowRun,event:'workflow_dispatch'}}
  ];
  for(const input of cases){
    const result=await reviewGitHubCiFailure(input);
    assert.equal(result.status,'blocked');
    assert.equal(result.mayEditDraft,false);
  }
  assert.equal(called,false);
});
test('failed fetch and malformed response fail closed without exposing errors',async()=>{
  for(const fn of [
    async()=>{throw Error('secret=private');},
    async()=>({result:{}}),
    async()=>({result:{content:null}}),
    async()=>({result:{content:'unknown failure'}})
  ]){
    const result=await reviewGitHubCiFailure({...base,github:{fetch_workflow_job_logs:fn}});
    assert.equal(result.status,'blocked');
    assert.equal(result.mayEditDraft,false);
    assert.equal(JSON.stringify(result).includes('secret=private'),false);
  }
});
