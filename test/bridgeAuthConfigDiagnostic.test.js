'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {diagnoseBridgeAuthConfig}=require('../src/bridgeAuthConfigDiagnostic');
test('missing Bridge keys are blocked',()=>{
 const r=diagnoseBridgeAuthConfig({});
 assert.equal(r.status,'BLOCKED');
 assert.equal(r.reason,'main_mcp_key_missing');
 assert.equal(r.verified,false);
});
test('configured keys do not imply authorized connection or leak secrets',()=>{
 const r=diagnoseBridgeAuthConfig({MCP_API_KEY:'PRIVATE_MAIN_KEY',CONNECTOR_API_KEY:'PRIVATE_CONNECTOR_KEY'});
 assert.equal(r.status,'PARTIAL');
 assert.equal(r.verified,false);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_MAIN_KEY|PRIVATE_CONNECTOR_KEY/);
});
test('connector key absence is independently reported',()=>{
 const r=diagnoseBridgeAuthConfig({MCP_API_KEY:'set'});
 assert.equal(r.reason,'connector_mcp_key_missing');
});
