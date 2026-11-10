'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createOzRouter}=require('../src/oz/router');
test('three entrances are exposed without registering endpoints',async()=>{
 const r=createOzRouter(); const v=await r.dispatch({entry:'OZ_CONTROL',operation:'capabilities'});
 assert.deepEqual(v.entries,['OZ_EXECUTE','OZ_QUERY','OZ_CONTROL']);
});
test('unknown operation fails closed',async()=>{
 assert.equal((await createOzRouter().dispatch({entry:'OZ_EXECUTE',operation:'missing'})).status,'BLOCKED');
});
test('write requires authentication and authorization',async()=>{
 let count=0; const r=createOzRouter({lanes:{write:{run:async()=>++count}},audit:()=>{}});
 for(const ctx of [{},{authenticated:true}]) assert.equal((await r.dispatch({entry:'OZ_EXECUTE',operation:'write'},ctx)).status,'BLOCKED');
 assert.equal(count,0);
 assert.equal((await r.dispatch({entry:'OZ_EXECUTE',operation:'write'},{authenticated:true,writeAuthorized:true})).status,'PARTIAL');
 assert.equal(count,1);
});
test('query cannot invoke write lane',async()=>{
 let count=0;const r=createOzRouter({lanes:{write:{run:()=>++count}}});
 assert.equal((await r.dispatch({entry:'OZ_QUERY',operation:'write'})).reasonCode,'QUERY_REQUIRES_READ_ONLY');
 assert.equal(count,0);
});
test('human gate and cost gate block',async()=>{
 const r=createOzRouter({lanes:{danger:{run:()=>1,humanGate:true},paid:{run:()=>1,costGate:true}}});
 assert.equal((await r.dispatch({entry:'OZ_EXECUTE',operation:'danger'},{authenticated:true,writeAuthorized:true})).reasonCode,'HUMAN_APPROVAL_REQUIRED');
 assert.equal((await r.dispatch({entry:'OZ_EXECUTE',operation:'paid'},{authenticated:true,writeAuthorized:true})).reasonCode,'COST_GATE');
});
test('lane exception does not leak secret',async()=>{
 const r=createOzRouter({lanes:{read:{readOnly:true,run:()=>{throw Error('secret123')}}},audit:()=>{}});
 const out=await r.dispatch({entry:'OZ_QUERY',operation:'read'});
 assert.equal(out.reasonCode,'LANE_EXECUTION_FAILED');
 assert.equal(JSON.stringify(out).includes('secret123'),false);
});
