'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {deflateRawSync}=require('node:zlib');
const {verifyCiArtifactZip}=require('../src/ciArtifactReader');
const {reviewGitHubStructuredArtifact}=require('../src/githubCiLogAdapter');
function crc32(buf){let c=0xffffffff;for(const b of buf){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function zipFile(name,text,method=8){
 const n=Buffer.from(name),raw=Buffer.from(text),packed=method===8?deflateRawSync(raw):raw,crc=crc32(raw);
 const l=Buffer.alloc(30),c=Buffer.alloc(46),e=Buffer.alloc(22);
 l.writeUInt32LE(0x04034b50);l.writeUInt16LE(method,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(packed.length,18);l.writeUInt32LE(raw.length,22);l.writeUInt16LE(n.length,26);
 c.writeUInt32LE(0x02014b50);c.writeUInt16LE(method,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(n.length,28);
 e.writeUInt32LE(0x06054b50);e.writeUInt16LE(1,8);e.writeUInt16LE(1,10);e.writeUInt32LE(c.length+n.length,12);e.writeUInt32LE(l.length+n.length+packed.length,16);
 return Buffer.concat([l,n,packed,c,n,e]);
}
const sha='a'.repeat(40),runId=44,attempt=1;
const steps={npm_test:'success',openapi_validation:'success',mcp_contract:'success',safety_validation:'success'};
const names={npm_test:'6. Run test suite',openapi_validation:'7. Validate OpenAPI',mcp_contract:'8. Validate MCP tool contract',safety_validation:'9. Validate canonical branch safety'};
const json=JSON.stringify({schema_version:1,source:'github_actions',run_id:runId,run_attempt:attempt,head_sha:sha,job_key:'test',steps});
function input(bytes){return{repositoryFullName:'oohiraplas-cpu/clean-nano-ai-bridge',zipBytes:bytes,artifact:{id:5,name:'ci-diagnostic-44-1',expired:false,workflow_run:{id:44},digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')},workflowRun:{id:44,run_attempt:1,head_sha:sha,status:'completed',conclusion:'success'},jobResponse:{total_count:1,jobs:[{id:2,name:'test',run_id:44,head_sha:sha,status:'completed',conclusion:'success',steps:Object.entries(names).map(([k,name])=>({name,conclusion:steps[k]}))}]},expectedHeadSha:sha,expectedRunAttempt:1};}
const {createGitHubCiArtifactService}=require('../src/githubCiArtifactService');
const {createApp}=require('../src/server');
const {getConfig}=require('../src/config');
const params={runId,artifactId:5,expectedHeadSha:sha,expectedRunAttempt:attempt};
function fixture(){
 const bytes=zipFile('diagnostic.json',json),proof=input(bytes);
 const f={bytes,proof,calls:[],reads:0,url:'https://test.blob.core.windows.net/file?sig=private'};
 proof.workflowRun.repository={full_name:'oohiraplas-cpu/clean-nano-ai-bridge'};
 proof.artifact.size_in_bytes=bytes.length;proof.artifact.workflow_run.head_sha=sha;
 f.fetch=async(url,opts)=>{
  f.calls.push({url,opts});assert.equal(opts.method,'GET');
  if(url===f.url)return new Response(f.bytes);
  if(url.endsWith('/zip'))return new Response(null,{status:302,headers:{location:f.url}});
  if(url.includes('/jobs?'))return Response.json(proof.jobResponse);
  if(url.endsWith('/artifacts/5'))return Response.json(proof.artifact);
  if(url.endsWith('/runs/44')){f.reads++;return Response.json(f.reads>1&&f.changedRun?f.changedRun:proof.workflowRun);}
  throw Error('unexpected request');
 };
 f.config={githubToken:'test-token',githubOwner:'oohiraplas-cpu',githubRepo:'clean-nano-ai-bridge',fetchImpl:f.fetch};
 f.verify=(p=params)=>createGitHubCiArtifactService(f.config).verify(p);return f;
}
test('real verifier and REST validation complete with GET only and no token on redirect',async()=>{
 const f=fixture(),r=await f.verify();assert.equal(r.status,'no_repair_needed');assert.equal(r.mayDeploy,false);assert.equal(f.reads,2);
 assert.equal(f.calls.find(c=>c.url===f.url).opts.headers,undefined);
 for(const c of f.calls.filter(c=>c.url!==f.url))assert.equal(c.opts.headers.authorization,'Bearer test-token');
 assert.equal(JSON.stringify(r).includes('private'),false);
});
test('bad caller params and missing credential do not perform network requests',async()=>{
 for(const p of [{...params,url:'https://evil.example'},{...params,runId:'44'},{...params,expectedHeadSha:'x'},{...params,zipBytes:'forged'}]){
 const f=fixture();assert.equal((await f.verify(p)).status,'blocked');assert.equal(f.calls.length,0);}
 for(const patch of [{githubToken:''},{githubRepo:'other'}]){const f=fixture();Object.assign(f.config,patch);assert.equal((await f.verify()).reason,'github_ci_reader_unavailable');assert.equal(f.calls.length,0);}
});
test('provenance mismatch blocks before ZIP download',async()=>{
 for(const modify of [f=>f.proof.workflowRun.head_sha='b'.repeat(40),f=>f.proof.workflowRun.run_attempt=2,f=>f.proof.artifact.expired=true,f=>f.proof.artifact.workflow_run.head_sha='b'.repeat(40)]){
 const f=fixture();modify(f);assert.equal((await f.verify()).status,'blocked');assert.equal(f.calls.some(c=>c.url.endsWith('/zip')),false);}
});
test('unsafe redirects cannot be requested',async()=>{
 for(const url of ['https://evil.example/file','http://test.blob.core.windows.net/file','https://user:pass@test.blob.core.windows.net/file','https://test.blob.core.windows.net:444/file']){
 const f=fixture();f.url=url;assert.equal((await f.verify()).reason,'github_ci_read_failed');assert.equal(f.calls.some(c=>c.url===url),false);}
});
test('tampering, oversized stream, missing REST proof and duplicate steps block',async()=>{
 for(const modify of [f=>f.proof.artifact.digest='sha256:'+'0'.repeat(64),f=>f.bytes=Buffer.alloc(65537),f=>delete f.proof.jobResponse.total_count,f=>delete f.proof.jobResponse.jobs[0].head_sha,f=>f.proof.jobResponse.jobs[0].steps.push({...f.proof.jobResponse.jobs[0].steps[0]})]){
 const f=fixture();modify(f);assert.equal((await f.verify()).status,'blocked');}
});
test('rerun during read is rejected and error secrets are not echoed',async()=>{
 const f=fixture();f.changedRun={...f.proof.workflowRun,run_attempt:2};assert.equal((await f.verify()).reason,'workflow_changed_during_read');
 f.config.fetchImpl=async()=>{throw Error('test-token '+f.url);};const r=await f.verify();assert.equal(r.reason,'github_ci_read_failed');assert.equal(JSON.stringify(r).includes('test-token'),false);
});
test('MCP authentication, listing, legacy and tools/call routes are wired',async t=>{
 const f=fixture(),config=getConfig({MCP_API_KEY:'mcp-test'});config.deployment=f.config;
 const app=createApp(config,{list:async()=>[]});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/mcp`;
 const post=(body,key='mcp-test')=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-api-key':key},body:JSON.stringify(body)});
 assert.equal((await post({method:'verify_github_ci_artifact',params},'wrong')).status,401);assert.equal(f.calls.length,0);
 const legacy=await(await post({method:'verify_github_ci_artifact',params})).json();assert.equal(legacy.result.status,'no_repair_needed');
 const rpc=await(await post({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'verify_github_ci_artifact',arguments:params}})).json();assert.equal(rpc.result.structuredContent.status,'no_repair_needed');
 const list=await(await post({jsonrpc:'2.0',id:3,method:'tools/list'})).json();assert.ok(list.result.tools.some(x=>x.name==='verify_github_ci_artifact'&&x.annotations.readOnlyHint));
});
test('missing MCP key blocks the new reader even with an Actions credential',async t=>{
 const f=fixture(),config=getConfig({});config.deployment=f.config;
 const server=createApp(config,{list:async()=>[]}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const r=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'verify_github_ci_artifact',params})});
 assert.equal((await r.json()).result.reason,'mcp_authentication_required');assert.equal(f.calls.length,0);
});
