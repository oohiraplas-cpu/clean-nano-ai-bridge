'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAzureKuduEvidenceReader}=require('../src/azureKuduEvidenceReader');
const resourceId='/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/clean-nano-ai-bridge';
const sha='a'.repeat(40);
test('Azure/Kudu requests are GET only and metadata never proves runtime SHA',async()=>{
 const calls=[];
 const reader=createAzureKuduEvidenceReader({resourceId,getArmToken:async()=> 'arm',getKuduToken:async()=> 'kudu',request:async x=>{
 calls.push(x);return {status:200,data:x.url.includes('management.azure.com')?{id:resourceId}:[{active:true,commitSha:sha}]};
 }});
 const result=await reader.inspect(sha);
 assert.equal(result.status,'blocked');
 assert.equal(result.historyMatched,true);
 assert.equal(result.runtimeShaVerified,false);
 assert.equal(calls.length,2);
 assert.ok(calls.every(c=>c.method==='GET'&&c.redirect==='error'));
 assert.ok(!JSON.stringify(result).includes('Bearer'));
});
test('no token or missing independent metadata fails closed',async()=>{
 const reader=createAzureKuduEvidenceReader({resourceId,getArmToken:async()=>null,getKuduToken:async()=>null,request:async()=>{throw Error('should not request');}});
 assert.equal((await reader.inspect(sha)).status,'blocked');
 assert.equal((await reader.inspect('invalid')).reason,'expected_sha_invalid');
});
test('other App Service scope is rejected',()=>{
 assert.throws(()=>createAzureKuduEvidenceReader({resourceId:resourceId.replace('clean-nano-ai-bridge','other'),request:()=>{},getArmToken:()=>{},getKuduToken:()=>{}}));
});
