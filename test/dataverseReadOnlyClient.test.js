'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createDataverseReadOnlyClient}=require('../src/dataverseReadOnlyClient');
const {createPowerPlatformReadOnlyAdapter}=require('../src/powerPlatformReadOnlyAdapter');
const config={orgUrl:'https://example.crm4.dynamics.com',tenantId:'11111111-1111-4111-8111-111111111111',clientId:'22222222-2222-4222-8222-222222222222',clientSecret:'PRIVATE_SECRET'};
test('Power Apps and Power Automate use token and GET without write operations',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,options});return url.includes('/token')?{status:200,json:async()=>({access_token:'SECRET_TOKEN',expires_in:3600})}:{status:200,json:async()=>({value:[]})};};
 const client=createDataverseReadOnlyClient(config,fetchImpl);
 const adapter=createPowerPlatformReadOnlyAdapter({client});
 assert.equal((await adapter.probePowerApps()).status,'PASS');
 assert.equal((await adapter.probePowerAutomate()).status,'PASS');
 assert.deepEqual(calls.map(c=>c.options.method),['POST','GET','GET']);
 assert.equal(calls[1].options.headers.authorization,'Bearer SECRET_TOKEN');
 assert.equal(calls.filter(c=>c.url.includes('/token')).length,1);
 assert.doesNotMatch(JSON.stringify(await adapter.probePowerApps()),/SECRET/);
});
test('arbitrary paths and external hosts are rejected before fetch',async()=>{
 let calls=0;
 const client=createDataverseReadOnlyClient(config,async()=>{calls++;throw Error('should_not_call');});
 await assert.rejects(client.get('PublishAllXml'),/read_path_not_allowed/);
 await assert.rejects(client.get('workflows(1)'),/read_path_not_allowed/);
 assert.equal(calls,0);
 assert.throws(()=>createDataverseReadOnlyClient({...config,orgUrl:'https://evil.example.com'}),/dataverse_configuration_required/);
});
test('authentication and Graph errors fail closed without token or secret leakage',async()=>{
 const fetchImpl=async()=>({status:401});
 const adapter=createPowerPlatformReadOnlyAdapter({client:createDataverseReadOnlyClient(config,fetchImpl)});
 const result=await adapter.probePowerApps();
 assert.equal(result.status,'BLOCKED');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SECRET|SECRET_TOKEN/);
});

test('Dataverse 401 and 403 fail closed after successful Entra token',async()=>{
 for(const status of [401,403]){
  const calls=[];
  const fetchImpl=async(url,options)=>{
   calls.push({url,method:options.method});
   return url.includes('/token')?{status:200,json:async()=>({access_token:'SECRET_TOKEN',expires_in:3600})}:{status};
  };
  const adapter=createPowerPlatformReadOnlyAdapter({client:createDataverseReadOnlyClient(config,fetchImpl)});
  const result=await adapter.probePowerAutomate();
  assert.equal(result.status,'BLOCKED');
  assert.equal(result.verified,false);
  assert.deepEqual(calls.map(c=>c.method),['POST','GET']);
  assert.doesNotMatch(JSON.stringify(result),/SECRET_TOKEN|PRIVATE_SECRET/);
 }
});
test('Dataverse redirect and invalid token response are rejected',async()=>{
 const redirect=async(url)=>url.includes('/token')?{status:200,json:async()=>({access_token:'SECRET_TOKEN',expires_in:3600})}:{status:302};
 const adapter=createPowerPlatformReadOnlyAdapter({client:createDataverseReadOnlyClient(config,redirect)});
 assert.equal((await adapter.probePowerApps()).status,'BLOCKED');
 const badToken=async()=>({status:200,json:async()=>({access_token:'SECRET_TOKEN',expires_in:0})});
 const invalid=createPowerPlatformReadOnlyAdapter({client:createDataverseReadOnlyClient(config,badToken)});
 assert.equal((await invalid.probePowerApps()).status,'BLOCKED');
});
