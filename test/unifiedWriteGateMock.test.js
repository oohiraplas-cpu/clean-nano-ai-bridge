'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateMockUnifiedWrite, digest } = require('../src/unifiedWriteGateMock');
const { ApprovalLedger } = require('../src/approvalLedger');
const { StateContextRegistry } = require('../src/stateContext');
const { _internal } = require('../src/platformManage');
const crypto = require('node:crypto');
const fields = Object.fromEntries(['requestId','stepIndex','tool','status','approver','approvedAt','revoked'].map(x=>[x,x]));
const config = {siteId:'site',listId:'ledger',fieldMap:fields};
function fixture() {
  let clock = Date.parse('2026-10-25T00:00:00Z');
  const registry = new StateContextRegistry({ttlMs:1000,now:()=>clock});
  const issued = registry.begin({appId:'app-1',environmentId:'env-1',branch:'main',canonicalBranch:'main',sha:'a'.repeat(40)},'credential-scope-A');
  const content = 'screen fixture';
  const sha = crypto.createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0').update(content).digest('hex');
  registry.bindSourceObservation(issued.correlationId,issued.stateSessionId,'credential-scope-A',{path:'S1_Home.pa.yaml',sha,content});
  const stateContext = registry.response(registry.lookup(issued.correlationId,issued.stateSessionId,'credential-scope-A')).stateContext;
  const params={targetApp:'app-1',relativePath:'S1_Home.pa.yaml',value:'new'};
  const binding={tool:'powerapps_manage',operation:'screen_edit',scope:'credential-scope-A',appId:stateContext.appId,environment:stateContext.environment,sha:stateContext.sha,paramsDigest:digest(params)};
  let row={requestId:'request-1',stepIndex:1,tool:'powerapps_manage',status:'承認',approver:'human@example.test',approvedAt:new Date(clock).toISOString(),revoked:false};
  const ledger=new ApprovalLedger({config,fetchRows:async()=>[row],now:()=>new Date(clock)});
  const input={tool:'powerapps_manage',operation:'screen_edit',params,stateContext,stateSessionId:issued.stateSessionId,scope:'credential-scope-A',registry,ledger,approval:{requestId:'request-1',stepIndex:1},binding,premiumScan:_internal.premiumScan,resolvedArtifact:{actions:{standard:{type:'OpenApiConnection',inputs:{host:{apiId:'/providers/Microsoft.PowerApps/apis/shared_sharepointonline'}}}}}};
  return {input,expire:()=>{clock+=1001},revoke:()=>{row={...row,revoked:true}},changeApproval:(patch)=>{row={...row,...patch}}};
}
test('mock common gate accepts exact synthetic state and human ledger approval but never executes',async()=>{
  const {input}=fixture();
  assert.deepEqual(await evaluateMockUnifiedWrite(input),{allowed:true,reason:'mock_gate_only_no_execution'});
});
test('mock common gate denies expired registry and credential scope mismatch',async()=>{
  const f=fixture(); f.expire();
  assert.equal((await evaluateMockUnifiedWrite(f.input)).reason,'state_registry_rejected');
  const g=fixture();
  assert.equal((await evaluateMockUnifiedWrite({...g.input,scope:'credential-scope-B'})).reason,'state_registry_rejected');
});
test('mock common gate denies revoked, missing and forged approval',async()=>{
  const f=fixture();f.revoke();
  assert.equal((await evaluateMockUnifiedWrite(f.input)).reason,'approval_rejected');
  const g=fixture();
  assert.equal((await evaluateMockUnifiedWrite({...g.input,approval:{requestId:'other',stepIndex:1},approvedByHuman:true})).reason,'approval_rejected');
  const h=fixture();
  assert.equal((await evaluateMockUnifiedWrite({...h.input,ledger:null})).reason,'gate_unconfigured');
});
test('mock common gate denies mismatched target, parameters, missing artifact and premium connector',async()=>{
  const f=fixture();
  assert.equal((await evaluateMockUnifiedWrite({...f.input,params:{...f.input.params,value:'tampered'}})).reason,'binding_mismatch');
  assert.equal((await evaluateMockUnifiedWrite({...f.input,binding:{...f.input.binding,appId:'other'}})).reason,'binding_mismatch');
  assert.equal((await evaluateMockUnifiedWrite({...f.input,resolvedArtifact:null})).reason,'artifact_unverified');
  assert.equal((await evaluateMockUnifiedWrite({...f.input,resolvedArtifact:{actions:{h:{type:'Http'}}}})).reason,'premium_or_unknown');
});
test('mock gate never enables production unified WRITE',async()=>{
  const {input}=fixture();
  const pm=require('../src/platformManage');
  const result=await pm.run('powerapps_manage',{operation:'screen_edit',approvedByHuman:true});
  assert.equal(result.status,'approval_required');
  assert.equal((await evaluateMockUnifiedWrite(input)).allowed,true);
});

const { evaluateStrictMockUnifiedWrite } = require('../src/unifiedWriteGateMock');
function strictFixture() {
  const f = fixture();
  const resource = { kind: 'powerapps-screen', id: 'S1_Home' };
  const { input } = f;
  const record = {
    requestId: input.approval.requestId, stepIndex: input.approval.stepIndex,
    tool: input.tool, operation: input.operation, paramsDigest: digest(input.params),
    scope: input.scope, environment: input.stateContext.environment,
    appId: input.stateContext.appId, sha: input.stateContext.sha,
    resourceKind: resource.kind, resourceId: resource.id
  };
  return { ...f, input: { ...input, resource, fetchApprovalEvidence: async () => ({...record}) }, record };
}
test('strict mock approves exact human-ledger-backed operation and resource only without execution', async () => {
  const f = strictFixture();
  assert.deepEqual(await evaluateStrictMockUnifiedWrite(f.input), {allowed:true,reason:'strict_mock_only_no_execution'});
});
test('strict mock rejects each independent approval evidence binding mismatch', async () => {
  for (const [key,value] of Object.entries({
    operation:'publish', paramsDigest:'0'.repeat(64), scope:'different-credential',
    environment:'other-env', appId:'other-app', sha:'f'.repeat(40),
    resourceKind:'sharepoint-list', resourceId:'different-screen',
    requestId:'other-request', stepIndex:2, tool:'sharepoint_manage'
  })) {
    const f = strictFixture();
    const actual = await evaluateStrictMockUnifiedWrite({...f.input, fetchApprovalEvidence:async()=>({...f.record,[key]:value})});
    assert.equal(actual.reason,'approval_evidence_mismatch',key);
  }
});
test('strict mock rejects missing or unreadable approval evidence and target', async () => {
  const f = strictFixture();
  assert.equal((await evaluateStrictMockUnifiedWrite({...f.input,fetchApprovalEvidence:null})).reason,'approval_evidence_unconfigured');
  assert.equal((await evaluateStrictMockUnifiedWrite({...f.input,fetchApprovalEvidence:async()=>{throw Error('offline')}})).reason,'approval_evidence_unreadable');
  assert.equal((await evaluateStrictMockUnifiedWrite({...f.input,fetchApprovalEvidence:async()=>null})).reason,'approval_evidence_missing');
  assert.equal((await evaluateStrictMockUnifiedWrite({...f.input,resource:null})).reason,'resource_missing');
});
test('strict mock still rejects expired registry, revoked approval and premium', async () => {
  const expired = strictFixture();expired.expire();
  assert.equal((await evaluateStrictMockUnifiedWrite(expired.input)).reason,'state_registry_rejected');
  const revoked = strictFixture();revoked.revoke();
  assert.equal((await evaluateStrictMockUnifiedWrite(revoked.input)).reason,'approval_rejected');
  const premium = strictFixture();
  assert.equal((await evaluateStrictMockUnifiedWrite({...premium.input,resolvedArtifact:{actions:{http:{type:'Http'}}}})).reason,'premium_or_unknown');
});
test('strict mock does not override actual unified WRITE denial', async () => {
  const f = strictFixture();
  assert.equal((await evaluateStrictMockUnifiedWrite(f.input)).allowed,true);
  const result=await require('../src/platformManage').run('powerapps_manage',{operation:'screen_edit',approvedByHuman:true});
  assert.equal(result.status,'approval_required');
});
