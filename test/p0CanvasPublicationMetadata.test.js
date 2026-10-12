'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCanvasPublicationMetadata } = require('../src/p0CanvasPublicationMetadata');
const appId='11111111-1111-1111-1111-111111111111';
const base={ expectedAppId:appId, expectedEnvironmentId:'env' };
test('publication timestamp alone is not published-version proof',async()=>{
  let calls=0;
  const store={appId,environmentId:'env',dataverseRequest:async path=>{calls++;assert.match(path,/lastpublishtime/);return {canvasappid:appId,appversion:'v1',lastpublishtime:'2026-10-13T00:00:00Z'};}};
  const r=await readCanvasPublicationMetadata({...base,store});
  assert.equal(calls,1);assert.equal(r.verified,false);assert.equal(r.reason,'published_version_not_independently_identified');
});
test('wrong environment blocks before network',async()=>{
  let calls=0;const store={appId,environmentId:'other',dataverseRequest:async()=>{calls++;return {};}};
  assert.equal((await readCanvasPublicationMetadata({...base,store})).reason,'reader_not_configured');assert.equal(calls,0);
});
test('missing publication metadata is rejected',async()=>{
  const store={appId,environmentId:'env',dataverseRequest:async()=>({canvasappid:appId,appversion:'v1'})};
  assert.equal((await readCanvasPublicationMetadata({...base,store})).reason,'metadata_incomplete');
});
