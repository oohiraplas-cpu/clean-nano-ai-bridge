'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {hashPlan,authorizeExecution} = require('../src/approvedExecutionGateDraft');
const sha = 'a'.repeat(40), base = 'b'.repeat(40);
const plan = operation => ({requestId:'r1',operation,targetId:'app',environmentId:'env',headSha:sha,baseSha:base});
test('draft CI operations are allowed without production authority',async()=>{
  assert.equal((await authorizeExecution({plan:plan('ci_verify')})).status,'PASS');
});
test('production operations require independent evidence',async()=>{
  for(const operation of ['main_merge','azure_config','deploy','powerapps_save','powerapps_publish']) {
    assert.equal((await authorizeExecution({plan:plan(operation)})).status,'BLOCKED');
  }
});
test('unknown operations and malformed SHA are blocked',async()=>{
  assert.equal((await authorizeExecution({plan:plan('permissions_change')})).status,'BLOCKED');
  assert.equal((await authorizeExecution({plan:{...plan('deploy'),headSha:'invalid'}})).status,'BLOCKED');
});
test('approval hash binds request, target, environment and SHA',()=>{
  assert.notEqual(hashPlan(plan('deploy')),hashPlan({...plan('deploy'),headSha:'c'.repeat(40)}));
});
test('single-use approval and fresh SHA checks must pass',async()=>{
  const p=plan('deploy'),planHash=hashPlan(p);
  const approval={status:'approved',revoked:false,planHash,requestId:p.requestId,operation:p.operation,targetId:p.targetId,environmentId:p.environmentId};
  const args={plan:p,approval,readHeadSha:async()=>sha,reserveApproval:async()=>({reserved:true,singleUseVerified:true,planHash,executionId:'once'}),recheckApproval:async()=>true};
  assert.equal((await authorizeExecution(args)).status,'PASS');
  assert.equal((await authorizeExecution({...args,readHeadSha:async()=>base})).status,'BLOCKED');
  assert.equal((await authorizeExecution({...args,recheckApproval:async()=>false})).status,'BLOCKED');
  assert.equal((await authorizeExecution({...args,approval:{...approval,revoked:true}})).status,'BLOCKED');
});
