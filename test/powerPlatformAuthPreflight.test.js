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
 const env={AZURE_TENANT_ID:'11111111-1111-4111-8111-111111111111',AZURE_CLIENT_ID:'22222222-2222-4222-8222-222222222222',AZURE_CLIENT_SECRET:'PRIVATE_PASSWORD',POWERAPPS_ORG_URL:'https://org123.crm7.dynamics.com'};
 const r=inspectPowerPlatformAuth(env);
 assert.equal(r.status,'PARTIAL');
 assert.equal(r.verified,false);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_PASSWORD|tenant-secret|client-secret|org123/);
});
test('untrusted Dataverse endpoint is rejected',()=>{
 const r=inspectPowerPlatformAuth({AZURE_TENANT_ID:'11111111-1111-4111-8111-111111111111',AZURE_CLIENT_ID:'22222222-2222-4222-8222-222222222222',AZURE_CLIENT_SECRET:'x',POWERAPPS_ORG_URL:'https://evil.example.com'});
 assert.equal(r.status,'BLOCKED');
 assert.ok(r.missing.includes('verified_dataverse_org_url'));
});

test('invalid tenant/client IDs and deceptive Dataverse URL fail closed',()=>{
 const env={AZURE_TENANT_ID:'not-a-guid',AZURE_CLIENT_ID:'not-a-guid',AZURE_CLIENT_SECRET:'secret',POWERAPPS_ORG_URL:'https://example.crm4.dynamics.com.evil.example'};
 const r=inspectPowerPlatformAuth(env);
 assert.equal(r.status,'BLOCKED');
 assert.ok(r.missing.includes('valid_tenant_id'));
 assert.ok(r.missing.includes('valid_client_id'));
 assert.ok(r.missing.includes('verified_dataverse_org_url'));
});
