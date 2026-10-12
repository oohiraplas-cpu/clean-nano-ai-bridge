'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assessStructuredDiagnostic}=require('../src/ciStructuredDiagnostic');
const {reviewGitHubStructuredDiagnostic}=require('../src/githubCiLogAdapter');
const sha='a'.repeat(40),runId=44,attempt=1;
const names={npm_test:'6. Run test suite',openapi_validation:'7. Validate OpenAPI',mcp_contract:'8. Validate MCP tool contract',safety_validation:'9. Validate canonical branch safety'};
const steps=Object.fromEntries(Object.keys(names).map(k=>[k,k==='npm_test'?'failure':'success']));
const diagnostic={schema_version:1,source:'github_actions',run_id:runId,run_attempt:attempt,head_sha:sha,job_key:'test',steps};
const workflowRun={id:runId,run_attempt:attempt,head_sha:sha,status:'completed',conclusion:'failure'};
const job={id:123,name:'test',run_id:runId,head_sha:sha,status:'completed',conclusion:'failure',steps:Object.entries(names).map(([k,name],i)=>({number:i+1,name,conclusion:steps[k]}))};
const artifact={id:5,name:'ci-diagnostic-44-1',expired:false,workflow_run:{id:44},digest:'sha256:'+'a'.repeat(64)};
const base={diagnosticJson:JSON.stringify(diagnostic),workflowRun,jobResponse:{total_count:1,jobs:[job]},artifact,expectedHeadSha:sha,expectedRunAttempt:attempt};
test('verified metadata yields review only, never repair authorization',()=>{
 const r=reviewGitHubStructuredDiagnostic(base);
 assert.equal(r.status,'review_required');assert.equal(r.stepKey,'npm_test');
 assert.equal(r.rootCauseVerified,false);
 for(const key of ['mayEditDraft','mayMerge','mayDeploy'])assert.equal(r[key],false);
});
test('provenance, scope and step inconsistencies fail closed',()=>{
 const cases=[
  {expectedHeadSha:'b'.repeat(40)},
  {expectedRunAttempt:2},
  {workflowRun:{...workflowRun,run_attempt:2}},
  {artifact:{...artifact,id:0}},
  {artifact:{...artifact,expired:true}},
  {artifact:{...artifact,digest:null}},
  {artifact:{...artifact,workflow_run:{id:45}}},
  {jobResponse:{total_count:2,jobs:[job]}},
  {jobResponse:{total_count:1,jobs:[{...job,head_sha:'b'.repeat(40)}]}},
  {jobResponse:{total_count:1,jobs:[{...job,steps:[...job.steps,{...job.steps[0]}]}]}},
  {diagnosticJson:JSON.stringify({...diagnostic,steps:{...steps,npm_test:'unknown'}})},
  {diagnosticJson:JSON.stringify({...diagnostic,steps:{...steps,npm_test:'success'}})},
  {diagnosticJson:JSON.stringify({...diagnostic,source:'untrusted'})},
  {diagnosticJson:'not json'},
  {diagnosticJson:'x'.repeat(4097)}
 ];
 for(const patch of cases){const r=assessStructuredDiagnostic({...base,...patch});
  assert.equal(r.status,'blocked');for(const k of ['mayEditDraft','mayMerge','mayDeploy'])assert.equal(r[k],false);}
});
test('diagnostic never emits secret strings or raw logs',()=>{
 const secret='secret-do-not-disclose';
 const r=assessStructuredDiagnostic({...base,diagnosticJson:JSON.stringify({...diagnostic,secret})});
 assert.equal(r.status,'blocked');
 assert.equal(JSON.stringify(r).includes(secret),false);
});
test('success path never authorizes writes',()=>{
 const okSteps=Object.fromEntries(Object.keys(steps).map(k=>[k,'success']));
 const result=assessStructuredDiagnostic({...base,workflowRun:{...workflowRun,conclusion:'success'},
 jobResponse:{total_count:1,jobs:[{...job,conclusion:'success',steps:job.steps.map(s=>({...s,conclusion:'success'}))}]},
 diagnosticJson:JSON.stringify({...diagnostic,steps:okSteps})});
 assert.equal(result.status,'no_repair_needed');assert.equal(result.mayEditDraft,false);
});
