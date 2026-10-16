'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SharePointListWriter } = require('../src/sharePointListWriter');
function writer(reply, observed) {
  return new SharePointListWriter({tenantId:'t',clientId:'c',clientSecret:'s',fetchImpl:async(url,opts)=>{
    if(url.includes('/token')) return {ok:true,json:async()=>({access_token:'mock',expires_in:3600})};
    observed.push({url,opts});return {ok:reply>=200&&reply<300,status:reply};
  }});
}
test('strong ETag is forwarded unchanged; no unconditional PATCH',async()=>{
  const seen=[];const w=writer(204,seen);
  assert.deepEqual(await w.patchItemFieldsIfMatch('site','list','item',{ReservationStatus:'reserved'},'"v1"'),{status:'ok'});
  assert.equal(seen.length,1);assert.equal(seen[0].opts.headers['If-Match'],'"v1"');
  assert.equal(seen[0].opts.method,'PATCH');
});
test('stale ETag blocks without retry',async()=>{
  const seen=[];const w=writer(412,seen);
  assert.equal((await w.patchItemFieldsIfMatch('s','l','i',{ReservationStatus:'reserved'},'"v1"')).status,'BLOCKED');
  assert.equal(seen.length,1);
});
test('missing, weak, or wildcard ETag rejects before network',async()=>{
  const seen=[];const w=writer(204,seen);
  for(const tag of ['', '*', 'W/"v1"', 'unquoted'])
    await assert.rejects(()=>w.patchItemFieldsIfMatch('s','l','i',{ReservationStatus:'reserved'},tag),/strong_etag_required/);
  assert.equal(seen.length,0);
});
test('server failure is never interpreted as reservation success',async()=>{
  const seen=[];const w=writer(500,seen);
  await assert.rejects(()=>w.patchItemFieldsIfMatch('s','l','i',{ReservationStatus:'reserved'},'"v1"'),/conditional_patch_failed/);
});
