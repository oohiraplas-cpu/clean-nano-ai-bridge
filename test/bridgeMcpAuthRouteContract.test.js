'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
// Regression contract: each MCP route must retain a fail-closed wrapper.
// Static guard deliberately avoids mutating production auth middleware.
test('MCP, connector and webhook routes use explicit fail-closed wrappers',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
 assert.match(source,/const mcpAuth = \(req, res, next\) => \(config\.mcpApiKey\s*\? mcpKeyAuth\(req, res, next\)\s*: res\.status\(503\)/);
 assert.match(source,/const connectorAuth = \(req, res, next\) => \(config\.connectorApiKey\s*\? connectorKeyAuth\(req, res, next\)\s*: res\.status\(404\)/);
 assert.match(source,/app\.post\('\/mcp', mcpAuth,/);
 assert.match(source,/app\.post\('\/connector\/mcp', connectorAuth,/);
 assert.match(source,/app\.get\('\/mcp\/tools\/list', mcpAuth,/);
});
