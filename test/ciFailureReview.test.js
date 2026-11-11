'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {classifyFailure,reviewCiFailure} = require('../src/ciFailureReview');
const sha='a'.repeat(40),branch='draft/vnext-automation-gates-20261012';
const workflowRun={id:44,head_sha:sha,head_branch:branch,event:'pull_request',status:'completed',conclusion:'failure'};
const steps=[{number:1,conclusion:'success',started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T00:00:01Z'},{number:2,conclusion:'failure',started_at:'2026-01-01T00:00:02Z',completed_at:'2026-01-01T00:00:03Z'}];
const job={id:123,run_id:44,head_sha:sha,name:'test',status:'completed',conclusion:'failure',steps};
const log='2026-01-01T00:00:00Z setup\n2026-01-01T00:00:02Z AssertionError: expected true';
const base={workflowRun,jobResponse:{total_count:1,jobs:[job]},expectedHeadSha:sha,branch};
test('verified failure generates review-only classification',async()=>{
  const calls=[];
  const result=await reviewCiFailure({...base,readJobLog:async id=>{calls.push(id);return log;}});
  assert.deepEqual(calls,[123]);
  assert.equal(result.status,'review_required');
  assert.equal(result.candidate.category,'test_failure');
  assert.equal(result.rootCauseVerified,false);
  assert.equal(result.mayEditDraft,false);
  assert.equal(result.mayDeploy,false);
  assert.equal(result.mayMerge,false);
  assert.equal(JSON.stringify(result).includes('AssertionError'),false);
});
test('success does not fetch logs',async()=>{
  const result=await reviewCiFailure({...base,workflowRun:{...workflowRun,conclusion:'success'},jobResponse:{total_count:1,jobs:[{...job,conclusion:'success'}]},readJobLog:async()=>{throw Error('must not fetch');}});
  assert.equal(result.status,'no_repair_needed');
});
test('unverified metadata never invokes log reader',async()=>{
  for(const patch of [
    {workflowRun:{...workflowRun,head_sha:'b'.repeat(40)}},
    {jobResponse:{jobs:[job]}},
    {jobResponse:{total_count:2,jobs:[job]}},
    {jobResponse:{total_count:1,jobs:[{...job,run_id:45}]}},
    {workflowRun:{...workflowRun,status:'in_progress',conclusion:null}},
    {jobResponse:{total_count:2,jobs:[job,{...job,id:124}]}},
  ]){
    let called=false;
    const result=await reviewCiFailure({...base,...patch,readJobLog:async()=>{called=true;return 'AssertionError';}});
    assert.equal(result.status,'blocked');
    assert.equal(result.mayEditDraft,false);
    assert.equal(called,false);
  }
});
test('missing reader, failed fetch, invalid and ambiguous logs fail closed',async()=>{
  const noReader=await reviewCiFailure(base);
  assert.equal(noReader.status,'blocked');
  for(const reader of [
    async()=>{throw Error('sensitive token');},
    async()=>null,
    async()=>'', 
    async()=> 'unknown error',
    async()=> '2026-01-01T00:00:02Z AssertionError and npm ERR!',
    async()=> '2026-01-01T00:00:02Z ' + 'AssertionError'.repeat(15000)
  ]){
    const result=await reviewCiFailure({...base,readJobLog:reader});
    assert.equal(result.status,'blocked');
    assert.equal(result.mayEditDraft,false);
    assert.equal(JSON.stringify(result).includes('sensitive token'),false);
  }
});
test('classifier never returns log lines or verifies root cause',()=>{
  const result=classifyFailure('permission denied secret=do-not-disclose');
  assert.equal(result.category,'permission_failure');
  assert.equal(result.reason,'classification_only');
  assert.equal(JSON.stringify(result).includes('do-not-disclose'),false);
});

test('step boundaries fail closed on overlap, missing timestamps, oversize and multiple failures',async()=>{
  const cases=[
    {steps:[...steps,{number:3,conclusion:'success',started_at:'2026-01-01T00:00:03Z',completed_at:'2026-01-01T00:00:04Z'}]},
    {steps:[...steps,{number:3,conclusion:'failure',started_at:'2026-01-01T00:00:04Z',completed_at:'2026-01-01T00:00:05Z'}]},
    {steps:[{...steps[0],completed_at:'bad'},steps[1]]},
    {steps:[steps[0],{...steps[1],started_at:'2026-01-01T00:00:00Z'}]},
    {log:'no timestamp\n'+log},
    {log:'2026-01-01T00:00:02Z AssertionError\n2026-01-01T00:00:00Z earlier'},
    {log:'2026-01-01T00:00:02Z '+('AssertionError'.repeat(15000))}
  ];
  for(const c of cases){
    const result=await reviewCiFailure({...base,jobResponse:{total_count:1,jobs:[{...job,steps:c.steps||steps}]},readJobLog:async()=>c.log||log});
    assert.equal(result.status,'blocked');
    assert.equal(result.mayEditDraft,false);
    assert.equal(result.mayDeploy,false);
  }
});
