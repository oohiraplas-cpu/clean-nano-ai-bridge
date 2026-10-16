'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createApp}=require('../src/server');
const target='oohiraplas-cpu/clean-nano-ai-bridge';
const branch='draft/approved-execution-engine-20261014';
const plan={requestId:'r',operation:'ci_verify',targetId:target,environmentId:branch,baseSha:'a'.repeat(40),headSha:'b'.repeat(40)};
async function withServer(key,fn){
 const app=createApp({mcpApiKey:key,corsOrigins:[],powerApps:{},sharepoint:{},powerAutomate:{flows:{}},deployment:{},permissions:{},enforceStateManager:false});
 const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});
 try {await fn('http://127.0.0.1:'+server.address().port)} finally {await new Promise(resolve=>server.close(resolve))}
}
async function post(url,body,key){return fetch(url+'/api/draft/ci-evidence',{method:'POST',headers:{'content-type':'application/json',...(key?{'x-api-key':key}:{})},body:JSON.stringify(body)})}
test('Draft CI HTTP endpoint requires MCP authentication',async()=>{
 await withServer('test-mcp-key',async(url)=>{
  assert.equal((await post(url,{plan})).status,401);
  assert.equal((await post(url,{plan},'wrong')).status,401);
  assert.equal((await post(url,{plan:{...plan,operation:'draft_edit'}},'test-mcp-key')).status,403);
  assert.equal((await post(url,{plan:{...plan,environmentId:'main'}},'test-mcp-key')).status,403);
  assert.equal((await post(url,{plan},'test-mcp-key')).status,503);
 });
});
test('Draft CI HTTP endpoint fails closed when MCP key is absent',async()=>{
 await withServer('',async(url)=>{
  const response=await post(url,{plan});
  assert.equal(response.status,503);
  assert.equal((await response.json()).status,'BLOCKED');
 });
});
