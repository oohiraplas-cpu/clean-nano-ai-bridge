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
test('verified ZIP yields read-only no-repair-needed',()=>{const b=zipFile('diagnostic.json',json);const r=reviewGitHubStructuredArtifact(input(b));assert.equal(r.status,'no_repair_needed');assert.equal(r.mayDeploy,false);});
test('ZIP tampering and mismatched digest fail closed',()=>{const b=zipFile('diagnostic.json',json);const bad=Buffer.from(b);bad[40]^=1;assert.equal(verifyCiArtifactZip({zipBytes:bad,artifact:input(b).artifact}).status,'blocked');});
test('ZIP slip, duplicate keys, oversized payload and wrong attempt fail closed',()=>{
 const cases=[zipFile('../diagnostic.json',json),zipFile('diagnostic.json','{"x":1,"x":2}'),zipFile('diagnostic.json','x'.repeat(4097)),zipFile('diagnostic.json',JSON.stringify({...JSON.parse(json),run_attempt:2}))];
 for(const b of cases)assert.equal(reviewGitHubStructuredArtifact(input(b)).status,'blocked');
});
test('multiple entries, oversized ZIP, malformed ZIP and missing bytes fail closed',()=>{
 const b=zipFile('diagnostic.json',json);
 const two=Buffer.from(b);two.writeUInt16LE(2,two.length-14);two.writeUInt16LE(2,two.length-12);
 for(const z of [two,Buffer.alloc(65537),Buffer.from('bad')])
  assert.equal(reviewGitHubStructuredArtifact(input(z)).status,'blocked');
 assert.equal(reviewGitHubStructuredArtifact({...input(b),zipBytes:null}).status,'blocked');
});
test('HEAD mismatch, untrusted repo and no secret echo',()=>{
 const b=zipFile('diagnostic.json',json);
 for(const patch of [{expectedHeadSha:'b'.repeat(40)},{repositoryFullName:'other/repo'}]){
  const r=reviewGitHubStructuredArtifact({...input(b),...patch});assert.equal(r.status,'blocked');
  assert.equal(JSON.stringify(r).includes(json),false);
 }
});
