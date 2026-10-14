'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const g=require('../src/productionEvidenceGateDraft');
const content='Screen: test';const runtimeHash=crypto.createHash('sha256').update(content).digest('hex');
const expected={appId:'app',environment:'env',path:'S1.pa.yaml'};
const source={status:'ok',source:'power-apps-saved-msapp',...expected,content,runtimeHash};
test('PAC source validates content and provenance',()=>assert.equal(g.validateRuntimeObservation(source,expected).status,'PASS'));
test('GitHub source is not runtime evidence',()=>assert.equal(g.validateRuntimeObservation({...source,source:'github'},expected).status,'BLOCKED'));
test('runtime hash mismatch blocks',()=>assert.equal(g.validateRuntimeObservation({...source,runtimeHash:'bad'},expected).status,'BLOCKED'));
test('wrong app blocks',()=>assert.equal(g.validateRuntimeObservation({...source,appId:'other'},expected).status,'BLOCKED'));
test('reservation requires durable ETag evidence',()=>assert.equal(g.validateApprovalReservation({reserved:true,singleUseVerified:true,planHash:'h',executionId:'e'}, {planHash:'h',executionId:'e'}).status,'BLOCKED'));
test('durable reservation evidence passes',()=>assert.equal(g.validateApprovalReservation({reserved:true,singleUseVerified:true,planHash:'h',executionId:'e',persisted:true,etagVerified:true},{planHash:'h',executionId:'e'}).status,'PASS'));
test('publish status ok passes request check',()=>assert.equal(g.validatePublishResponse({status:'ok',appId:'app',operationId:'op'},'app').status,'PASS'));
test('publish error blocks',()=>assert.equal(g.validatePublishResponse({status:'error',appId:'app',operationId:'op'},'app').status,'BLOCKED'));
test('version without independent artifact blocks',()=>assert.equal(g.validatePublishedVersion({publishedVersion:'1'}, {appId:'app',environmentId:'env',version:'1',artifactHash:'hash'}).status,'BLOCKED'));
test('independent matching artifact passes',()=>assert.equal(g.validatePublishedVersion({source:'independent_published_artifact',appId:'app',environmentId:'env',publishedVersion:'1',artifactHash:'hash'}, {appId:'app',environmentId:'env',version:'1',artifactHash:'hash'}).status,'PASS'));

test('conditional approval reservation verifies ETag readback',async()=>{
  let item={etag:'v1',status:'approved',revoked:false,planHash:'p'};
  const result=await g.reserveSharePointApproval({
    readItem:async()=>({...item}),
    patchIfMatch:async({etag,fields})=>{assert.equal(etag,'v1');item={...item,...fields,etag:'v2'};return {status:'ok'};},
    expected:{planHash:'p'},executionId:'once'
  });
  assert.equal(result.status,'PASS');
});
test('approval reservation rejects stale ETag or absent readback',async()=>{
  const result=await g.reserveSharePointApproval({
    readItem:async()=>({etag:'v1',status:'approved',revoked:false,planHash:'p'}),
    patchIfMatch:async()=>({status:'ok'}),expected:{planHash:'p'},executionId:'once'
  });
  assert.equal(result.status,'BLOCKED');
});
test('independent published artifact reader rejects version mismatch',async()=>{
  const expected={appId:'a',environmentId:'e',version:'2',artifactHash:'hash'};
  const result=await g.verifyIndependentPublishedArtifact({
    readPublishedArtifact:async()=>({source:'independent_published_artifact',appId:'a',environmentId:'e',publishedVersion:'1',artifactHash:'hash'}),expected
  });
  assert.equal(result.status,'BLOCKED');
});
test('published artifact reader failure is fail closed',async()=>{
  const result=await g.verifyIndependentPublishedArtifact({
    readPublishedArtifact:async()=>{throw Error('offline')},
    expected:{appId:'a',environmentId:'e',version:'2',artifactHash:'hash'}
  });
  assert.equal(result.status,'BLOCKED');
});
