'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {inspectMcpRoute}=require('../src/mcpAuthRouteInspector');
test('main MCP and connector have distinct static contracts',()=>{
 const main=inspectMcpRoute({path:'/mcp',authScheme:'x-api-key'});
 const connector=inspectMcpRoute({path:'/connector/mcp',authScheme:'query_api_key'});
 assert.equal(main.status,'PARTIAL');
 assert.equal(connector.status,'PARTIAL');
 assert.equal(main.missingKeyHttpStatus,503);
 assert.equal(connector.missingKeyHttpStatus,404);
 assert.equal(main.verified,false);
});
test('Entra JWT cannot be used as main MCP API key',()=>{
 assert.equal(inspectMcpRoute({path:'/mcp',authScheme:'entra_bearer_jwt'}).reason,'auth_scheme_mismatch');
 assert.equal(inspectMcpRoute({path:'/recovery/mcp',authScheme:'entra_bearer_jwt'}).status,'PARTIAL');
});
test('unknown paths, GET and absent auth are blocked',()=>{
 assert.equal(inspectMcpRoute({path:'/mcp-v2',authScheme:'x-api-key'}).status,'BLOCKED');
 assert.equal(inspectMcpRoute({path:'/mcp',method:'GET',authScheme:'x-api-key'}).status,'BLOCKED');
 assert.equal(inspectMcpRoute({path:'/mcp'}).status,'BLOCKED');
});
