'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {inspectPowerPlatformAuth}=require('../src/powerPlatformAuthPreflight');
test('unconfigured auth fails closed',()=>{
 const r=inspectPowerPlatformAuth({});
 assert.equal(r.status,'BLOCKED');
 assert.equal(r.verified,false);
 assert.ok(r.missing.includes('client_credential'));
});
test('existing Azure credential fallback is reported as configured but not authenticated',()=>{
 const env={AZURE_TENANT_ID:'tenant-secret',AZURE_CLIENT_ID:'client-secret',AZURE_CLIENT_SECRET:'PRIVATE_PASSWORD',POWERAPPS_ORG_URL:'https://org123.crm7.dynamics.com'};
 const r=inspectPowerPlatformAuth(env);
 assert.equal(r.status,'PARTIAL');
 assert.equal(r.verified,false);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_PASSWORD|tenant-secret|client-secret|org123/);
});
test('untrusted Dataverse endpoint is rejected',()=>{
 const r=inspectPowerPlatformAuth({AZURE_TENANT_ID:'x',AZURE_CLIENT_ID:'x',AZURE_CLIENT_SECRET:'x',POWERAPPS_ORG_URL:'https://evil.example.com'});
 assert.equal(r.status,'BLOCKED');
 assert.ok(r.missing.includes('verified_dataverse_org_url'));
});
