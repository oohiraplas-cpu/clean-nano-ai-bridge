'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPowerPlatformReadOnlyAdapter}=require('../src/powerPlatformReadOnlyAdapter');
test('Power Apps and Power Automate use GET-only existing client',async()=>{
 const paths=[];
 const adapter=createPowerPlatformReadOnlyAdapter({client:{get:async p=>{paths.push(p);return {value:[]};}}});
 assert.equal((await adapter.probePowerApps()).status,'PASS');
 assert.equal((await adapter.probePowerAutomate()).status,'PASS');
 assert.equal(paths.length,2);
 assert.ok(paths[0].startsWith('canvasapps?'));
 assert.ok(paths[1].startsWith('workflows?'));
});
test('record inspection only accepts GUID and exposes no record data',async()=>{
 const calls=[];
 const adapter=createPowerPlatformReadOnlyAdapter({client:{get:async p=>{calls.push(p);return {name:'SECRET',canvasappid:'id'};}}});
 assert.equal((await adapter.inspectApp('bad')).status,'BLOCKED');
 assert.equal(calls.length,0);
 const id='11111111-1111-4111-8111-111111111111';
 const result=await adapter.inspectApp(id);
 assert.equal(result.status,'PASS');
 assert.doesNotMatch(JSON.stringify(result),/SECRET/);
});
test('auth errors and malformed responses fail closed without secret leakage',async()=>{
 const adapter=createPowerPlatformReadOnlyAdapter({client:{get:async()=>{throw Error('PRIVATE_TOKEN');}}});
 const r=await adapter.probePowerApps();
 assert.equal(r.status,'BLOCKED');
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_TOKEN/);
 const malformed=createPowerPlatformReadOnlyAdapter({client:{get:async()=>({})}});
 assert.equal((await malformed.probePowerAutomate()).status,'BLOCKED');
});
test('timeout and missing client are rejected',async()=>{
 assert.throws(()=>createPowerPlatformReadOnlyAdapter({}),/existing_dataverse_client_required/);
 const adapter=createPowerPlatformReadOnlyAdapter({client:{get:()=>new Promise(()=>{})},timeoutMs:5});
 assert.equal((await adapter.probePowerApps()).status,'BLOCKED');
});
