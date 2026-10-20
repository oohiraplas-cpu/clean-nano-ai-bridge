'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../src/server.js'),'utf8');
test('Power Automate writer is lazy and only resolved in flow execution branch',()=>{
 assert.doesNotMatch(source,/^const powerAutomateFlowWriter = require\('\.\/powerAutomateFlowWriter'\);/m);
 assert.match(source,/const d = await require\('\.\/powerAutomateFlowWriter'\)\[fn\]\(p\)/);
});
test('State Manager and approval gates remain imported and enforced',()=>{
 assert.match(source,/require\('\.\/stateManager'\)/);
 assert.match(source,/new ExecutionQueue\(\{ ledger: new ApprovalLedger\(\) \}\)/);
 assert.match(source,/stateRegistry\.validate\(/);
 assert.match(source,/apiKeyMiddleware/);
});
