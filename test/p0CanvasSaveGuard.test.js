'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireVerifiedCanvasSave } = require('../src/p0CanvasSaveGuard');
test('missing writer never claims a save', async () => {
  assert.deepEqual(await requireVerifiedCanvasSave({ appId:'app', environmentId:'env', expectedVersion:'1' }), {status:'BLOCKED',reason:'verified_save_adapter_not_configured'});
});
test('unverified writer never executes even when injected', async () => {
  let calls=0;
  const result=await requireVerifiedCanvasSave({ appId:'app', environmentId:'env', expectedVersion:'1', saveWriter:async()=>{calls++;}, verifySavedVersion:async()=>{calls++;} });
  assert.equal(result.status,'BLOCKED');assert.equal(result.reason,'canvas_save_api_contract_unverified');assert.equal(calls,0);
});
