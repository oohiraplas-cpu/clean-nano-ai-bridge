'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assessEtagWrite}=require('../src/lv5EtagPreflight');
const etag='"975d0fb7-9a53-43cd-9803-821b880f7019,2"';
const input={expectedEtag:etag,currentEtag:etag,environment:'isolated',requestId:'req-1',approval:{verified:true,requestId:'req-1'}};
test('matching ETag still requires separate authorization and If-Match',()=>{
 const r=assessEtagWrite(input);assert.equal(r.status,'ELIGIBLE_FOR_SEPARATE_AUTHORIZATION');assert.equal(r.writeAllowed,false);assert.equal(r.requiredIfMatch,etag);
});
test('ETag mismatch fails closed',()=>assert.equal(assessEtagWrite({...input,currentEtag:'"different,3"'}).reason,'etag_conflict'));
test('missing approval and production fail closed',()=>{
 assert.equal(assessEtagWrite({...input,approval:null}).status,'BLOCKED');
 assert.equal(assessEtagWrite({...input,environment:'production'}).status,'BLOCKED');
});
