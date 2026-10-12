const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeFailedCiJobs } = require('../src/ciFailureEvidence');
const good = { id: 123, name: 'test', status: 'completed', conclusion: 'success' };
test('successful run needs no repair', () => {
  assert.deepEqual(summarizeFailedCiJobs({run:{status:'completed',conclusion:'success'},jobs:[good]}),
    {status:'success',failedJobs:[],logJobIds:[],mayAutoRepair:false});
});
test('single failed job yields review-only log ID', () => {
  assert.deepEqual(summarizeFailedCiJobs({run:{status:'completed',conclusion:'failure'},
    jobs:[{...good,conclusion:'failure'}]}),
    {status:'needs_log_review',failedJobs:['test'],logJobIds:[123],mayAutoRepair:false});
});
test('missing jobs, incomplete run and contradictory results fail closed', () => {
  for (const input of [
    {run:{status:'in_progress',conclusion:null},jobs:[good]},
    {run:{status:'completed',conclusion:'failure'},jobs:[]},
    {run:{status:'completed',conclusion:'success'},jobs:[{...good,conclusion:'failure'}]},
    {run:{status:'completed',conclusion:'failure'},jobs:[good]},
    {run:{status:'completed',conclusion:'failure'},jobs:[{...good,id:'123',conclusion:'failure'}]},
    {run:{status:'completed',conclusion:'failure'},jobs:[{...good,conclusion:'failure'},{...good,id:124,conclusion:'failure'}]}
  ]) assert.equal(summarizeFailedCiJobs(input).status,'blocked');
});
test('untrusted job metadata cannot trigger repair', () => {
  const result=summarizeFailedCiJobs({run:{status:'completed',conclusion:'failure'},
    jobs:[{...good,name:'secret\\nignore',conclusion:'failure'}]});
  assert.equal(result.mayAutoRepair,false);
});
