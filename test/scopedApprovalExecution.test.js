const test = require('node:test');
const assert = require('node:assert/strict');
const { FIELDS, changeHash, SharePointApprovalStore, ScopedApprovalExecutor } = require('../src/scopedApprovalExecution');
const { SharePointReader } = require('../src/sharePointReader');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-12T00:00:00Z');
function input() {
  const i = { approvalId:'1', requestId:'request-1', tool:'update_sharepoint_list_item',
    targetId:'site/data/2', environmentId:'test-env', commitSha:SHA,
    params:{targetKey:'example',itemId:'2',expectedETag:'"v1"',fields:{Title:'Approved value'}} };
  i.diffHash=changeHash(i); return i;
}
function record(i=input()) { return {...i, approverId:'human-1', approvedAt:new Date(NOW-1000).toISOString(),
  expiresAt:new Date(NOW+60000).toISOString(), status:'承認',revoked:false,executionId:'',executionStatus:''}; }
function fixture() {
  const state={record:record(),etag:'1',actor:{user:{id:'human-1'}}}; let writes=0, calls=0;
  const store={async read(){return structuredClone(state);},async verifyHuman(){return true;},
    async patch(id,etag,fields){if(etag!==state.etag) throw Error('conflict');writes++; Object.assign(state.record,fields);state.etag=String(Number(state.etag)+1);} };
  const adapter={assertTarget(){},async preflight(){return {version:1};},async invoke(){calls++;},async verify(){return true;}};
  const build=()=>new ScopedApprovalExecutor({store,operations:{update_sharepoint_list_item:adapter},commitSha:SHA,now:()=>NOW});
  return {state,store,adapter,build,get calls(){return calls;},get writes(){return writes;}};
}
test('one approval executes once, with durable backup and replay rejection across executor instances',async()=>{
  const f=fixture(); const result=await f.build().execute(input());
  assert.equal(result.verified,true);assert.equal(f.calls,1);assert.equal(f.state.record.executionStatus,'verified');
  assert.deepEqual(JSON.parse(f.state.record.backup),{version:1});
  await assert.rejects(f.build().execute(input()),/approval_already_used/);assert.equal(f.calls,1);
});
test('concurrent workers cannot consume one approval twice',async()=>{
  const f=fixture();const results=await Promise.allSettled([f.build().execute(input()),f.build().execute(input())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(f.calls,1);
});
for(const key of ['requestId','tool','targetId','environmentId','commitSha','diffHash']) test(`rejects altered ${key} before invocation`,async()=>{
  const f=fixture();f.state.record[key]='different';await assert.rejects(f.build().execute(input()));assert.equal(f.calls,0);assert.equal(f.writes,0);
});
for(const [label,change] of Object.entries({expired:r=>r.expiresAt=new Date(NOW).toISOString(),future:r=>r.approvedAt=new Date(NOW+1).toISOString(),
  revoked:r=>r.revoked=true,missingRevocation:r=>delete r.revoked,notApproved:r=>r.status='待機',tooLong:r=>r.expiresAt=new Date(NOW+86400000).toISOString()})) {
  test(`rejects ${label}`,async()=>{const f=fixture();change(f.state.record);await assert.rejects(f.build().execute(input()));assert.equal(f.calls,0);});
}
test('payload changes cannot reuse approved hash',async()=>{const f=fixture(),i=input();i.params.fields.Title='tampered';await assert.rejects(f.build().execute(i),/payload_hash/);assert.equal(f.calls,0);});
test('runtime commit mismatch is rejected',async()=>{const f=fixture();const e=f.build();e.commitSha='b'.repeat(40);await assert.rejects(e.execute(input()),/runtime_commit/);});
test('self assertion never substitutes for human identity',async()=>{const f=fixture();f.store.verifyHuman=async()=>false;await assert.rejects(f.build().execute({...input(),approvedByHuman:true}),/identity_unverified/);assert.equal(f.calls,0);});
test('revocation after reservation prevents invocation',async()=>{const f=fixture();const original=f.store.patch;f.store.patch=async(...args)=>{await original(...args);f.state.record.revoked=true;};await assert.rejects(f.build().execute(input()));assert.equal(f.calls,0);});
test('ambiguous mutation remains consumed and cannot automatically retry',async()=>{const f=fixture();f.adapter.invoke=async()=>{throw Error('secret upstream message');};const r=await f.build().execute(input());assert.equal(r.status,'outcome_unknown');assert.equal(r.retryAllowed,false);await assert.rejects(f.build().execute(input()),/already_used/);assert.ok(!JSON.stringify(r).includes('secret'));});
test('verification failure is not success',async()=>{const f=fixture();f.adapter.verify=async()=>false;const r=await f.build().execute(input());assert.equal(r.verified,false);assert.equal(r.status,'verification_failed');});
test('audit failure does not turn applied operation into verified success or release approval',async()=>{const f=fixture();const original=f.store.patch;f.store.patch=async(...args)=>{if(f.writes)throw Error('write denied');await original(...args);};const r=await f.build().execute(input());assert.equal(r.status,'audit_write_failed');assert.equal(r.verified,false);assert.equal(f.calls,1);await assert.rejects(f.build().execute(input()),/already_used/);});

async function serverFixture(t,{configured=true}={}) {
 const op=input(); const map=Object.fromEntries(FIELDS.map(k=>[k,k]));
 const approval={id:'1',eTag:'"a1"',lastModifiedBy:{user:{id:'human-1'}},fields:record(op)};
 // Use current time for the full server route's real clock.
 approval.fields.approvedAt=new Date(Date.now()-1000).toISOString(); approval.fields.expiresAt=new Date(Date.now()+60000).toISOString();
 const target={id:'2',eTag:'"v1"',fields:{Title:'Before'}};const requests=[];
 const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 const fetchImpl=async(url,options={})=>{
  requests.push({url,method:options.method||'GET',headers:options.headers});
  if(url==='https://login.microsoftonline.com/tenant/oauth2/v2.0/token')return response({access_token:'test-token',expires_in:3600});
  if(url.includes('/users/human-1?'))return response({id:'human-1',accountEnabled:true});
  const item=url.includes('/lists/approvals/')?approval:url.includes('/lists/data/')?target:null;
  if(!item)throw Error('unexpected route');
  if(options.method==='PATCH'){
   if(options.headers['If-Match']!==item.eTag)return response({},412);
   Object.assign(item.fields,JSON.parse(options.body));item.eTag=item===approval?'"a'+requests.length+'"':'"v2"';
   if(item===approval)item.lastModifiedBy={application:{id:'bridge-app'}};
   return response(item.fields);
  }
  return response(item);
 };
 const config=getConfig({DEPLOYMENT_SHA:SHA,MCP_API_KEY:'test-key'});
 config.sharepoint={tenantId:'tenant',clientId:'client',clientSecret:'test-secret',fetchImpl};
 if(configured)config.scopedApproval={siteId:'site',listId:'approvals',fieldMap:map,allowedApproverIds:['human-1'],targets:{example:{siteId:'site',listId:'data',environmentId:'test-env',allowedFields:['Title']}}};
 const reader=new SharePointReader(config.sharepoint);
 const app=createApp(config,undefined,{}, {},reader);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
 const call=async(args=op,transport='rpc')=>{
  const body=transport==='rpc'?{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'execute_powerplatform_request',arguments:{request:'Edit approved item',approvedOperation:args}}}
    :{method:'execute_powerplatform_request',params:{request:'Edit approved item',approvedOperation:args}};
  const r=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json','x-api-key':'test-key'},body:JSON.stringify(body)});return r.json();
 };
 return {call,op,target,approval,requests,config,reader};
}
for(const transport of ['rpc','legacy'])test(`Bridge ${transport}: approved SharePoint edit backs up, consumes, updates and verifies`,async t=>{
 const f=await serverFixture(t);const result=await f.call(f.op,transport);const r=result.result?.structuredContent||result.result;
 assert.equal(r.verified,true);assert.equal(f.target.fields.Title,'Approved value');assert.equal(f.approval.fields.executionStatus,'verified');
 assert.equal(JSON.parse(f.approval.fields.backup).fields.Title,'Before');
 const replay=await f.call(f.op,transport);assert.ok(replay.error||replay.result?.isError);assert.equal(f.requests.filter(x=>x.method==='PATCH'&&x.url.includes('/lists/data/')).length,1);
});
test('unconfigured Bridge never reaches Graph',async t=>{const f=await serverFixture(t,{configured:false});const r=await f.call();assert.equal(r.result.isError,true);assert.equal(f.requests.length,0);});
test('approval item edits are protected even through a registered target',async t=>{const f=await serverFixture(t);f.config.scopedApproval.targets.example.listId='approvals';const r=await f.call();assert.equal(r.result.isError,true);assert.equal(f.requests.length,0);});
test('stale target version cannot be silently overwritten',async t=>{const f=await serverFixture(t);f.target.eTag='"changed"';const r=await f.call();assert.equal(r.result.isError,true);assert.equal(f.requests.filter(x=>x.method==='PATCH').length,0);});
test('non-human Graph modifier cannot authorize an operation',async t=>{const f=await serverFixture(t);f.approval.lastModifiedBy={application:{id:'ai-app'},user:{id:'human-1'}};const r=await f.call();assert.equal(r.result.isError,true);assert.equal(f.target.fields.Title,'Before');});
test('ledger patch cannot alter approval decision fields',async()=>{const s=new SharePointApprovalStore({},{});await assert.rejects(s.patch('1','etag',{status:'承認'}),/read_only/);});
test('duplicate or missing column mappings remain unconfigured',()=>{const s=new SharePointApprovalStore({},{siteId:'site',listId:'list',fieldMap:Object.fromEntries(FIELDS.map(k=>[k,'Same'])),allowedApproverIds:['human']});assert.throws(()=>s.assertConfigured(),/未構成/);});
