'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { azureRuntimeArmDiagnostics } = require('../src/azureRuntimeArmDiagnostics');
const id = '/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/clean-nano/providers/Microsoft.Web/sites/clean-nano-ai-bridge';
const env = { AZURE_RUNTIME_DIAGNOSTIC_RESOURCE_ID:id, IDENTITY_ENDPOINT:'http://127.0.0.1:8081/msi/token', IDENTITY_HEADER:'private-header', POWERAPPS_RUNTIME_SOURCE_ADAPTER:'pac' };
test('fail closed without target or identity endpoint; never call network', async () => {
  let called = 0;
  const fetcher = async () => { called++; throw Error('unexpected'); };
  assert.equal((await azureRuntimeArmDiagnostics({}, fetcher)).arm.reason,'target_not_configured');
  assert.equal((await azureRuntimeArmDiagnostics({AZURE_RUNTIME_DIAGNOSTIC_RESOURCE_ID:id},fetcher)).arm.reason,'managed_identity_endpoint_unavailable');
  assert.equal(called,0);
});
test('read only ARM GET and list settings POST; mask all values and IDs', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({url, method:options.method});
    if (calls.length===1) return {ok:true,json:async()=>({access_token:'top-secret-token'})};
    if (calls.length===2) return {ok:true,json:async()=>({identity:{type:'SystemAssigned, UserAssigned',principalId:'private-principal',userAssignedIdentities:{'/private/id':{}}}})};
    return {ok:true,json:async()=>({properties:{POWERAPPS_RUNTIME_SOURCE_MAP:'secret-map',OTHER_SECRET:'secret-value'}})};
  };
  const result=await azureRuntimeArmDiagnostics(env,fetcher);
  assert.equal(result.arm.status,'observed');
  assert.deepEqual(result.arm.managedIdentity,{systemAssigned:true,userAssigned:true});
  assert.equal(result.arm.keys.POWERAPPS_RUNTIME_SOURCE_MAP,'present');
  assert.equal(result.arm.keys.POWERAPPS_RUNTIME_PAC,'missing');
  assert.deepEqual(calls.map(c=>c.method),['GET','GET','POST']);
  const output=JSON.stringify(result);
  for(const secret of ['top-secret-token','private-principal','private/id','secret-map','secret-value',id,'private-header'])assert.equal(output.includes(secret),false);
});
test('deny when ARM access fails, no settings request or secret echo', async () => {
  let n=0;
  const fetcher=async()=>{n++;return n===1?{ok:true,json:async()=>({access_token:'secret'})}:{ok:false,status:403};};
  const result=await azureRuntimeArmDiagnostics(env,fetcher);
  assert.equal(result.arm.status,'blocked');
  assert.equal(result.arm.reason,'identity_read_denied');
  assert.equal(n,2);
});
test('reject unsafe identity endpoints and targets', async () => {
  const result=await azureRuntimeArmDiagnostics({...env,IDENTITY_ENDPOINT:'https://evil.example/token'},async()=>{throw Error('must not call');});
  assert.equal(result.arm.status,'blocked');
});

test('rejects other App Service and mismatched runtime site name', async () => {
  const never = async () => { throw Error('unexpected network call'); };
  assert.equal((await azureRuntimeArmDiagnostics({...env,AZURE_RUNTIME_DIAGNOSTIC_RESOURCE_ID:id.replace('clean-nano-ai-bridge','other-app')},never)).arm.reason,'target_mismatch');
  assert.equal((await azureRuntimeArmDiagnostics({...env,WEBSITE_SITE_NAME:'other-app'},never)).arm.reason,'target_mismatch');
});
test('valid existing user assigned identity is selected without returning its ID', async () => {
  const clientId='12345678-1234-1234-1234-123456789abc';
  let tokenUrl;
  let n=0;
  const fetcher=async(url)=>{
    n++;
    if(n===1){tokenUrl=new URL(url);return {ok:true,json:async()=>({access_token:'token'})};}
    if(n===2)return {ok:true,json:async()=>({identity:{type:'UserAssigned'}})};
    return {ok:true,json:async()=>({properties:{}})};
  };
  const result=await azureRuntimeArmDiagnostics({...env,POWERAPPS_RUNTIME_MI_CLIENT_ID:clientId},fetcher);
  assert.equal(tokenUrl.searchParams.get('client_id'),clientId);
  assert.equal(result.arm.status,'observed');
  assert.equal(JSON.stringify(result).includes(clientId),false);
  assert.deepEqual(result.arm.managedIdentity,{systemAssigned:false,userAssigned:true});
});
test('invalid identity client ID blocks before network call', async () => {
  const result=await azureRuntimeArmDiagnostics({...env,POWERAPPS_RUNTIME_MI_CLIENT_ID:'unsafe'},async()=>{throw Error('unexpected network');});
  assert.equal(result.arm.reason,'invalid_managed_identity_client_id');
});
