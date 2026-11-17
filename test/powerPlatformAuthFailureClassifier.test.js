'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {classifyAuthFailure}=require('../src/powerPlatformAuthFailureClassifier');
test('Dataverse rejects Bridge API-key transports',()=>{
 const r=classifyAuthFailure({service:'dataverse',httpStatus:401,transport:'x-api-key',configured:true});
 assert.equal(r.reason,'dataverse_auth_transport_mismatch');
 assert.equal(r.verified,false);
});
test('Bridge rejects Entra client-credentials transport as an API key',()=>{
 const r=classifyAuthFailure({service:'bridgeMcp',httpStatus:401,transport:'entra_client_credentials',configured:true});
 assert.equal(r.reason,'bridge_api_key_transport_mismatch');
});
test('401 cannot be misreported as success',()=>{
 const r=classifyAuthFailure({service:'bridgeConnector',httpStatus:401,transport:'query_api_key',configured:true});
 assert.equal(r.status,'BLOCKED');
 assert.equal(r.reason,'credential_rejected_or_upstream_auth');
});
test('HTTP 200 is not proof of authorized operation',()=>{
 const r=classifyAuthFailure({service:'dataverse',httpStatus:200,transport:'entra_client_credentials',configured:true});
 assert.equal(r.status,'PARTIAL');
 assert.equal(r.verified,false);
});
test('missing configuration and unknown service fail closed',()=>{
 assert.equal(classifyAuthFailure({service:'bridgeMcp',httpStatus:200,transport:'x-api-key'}).status,'BLOCKED');
 assert.equal(classifyAuthFailure({service:'other',httpStatus:200,transport:'x-api-key',configured:true}).status,'BLOCKED');
});
