'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createArmMetadataCollector}=require('../src/azureArmMetadataCollector');
const {createAzureMetadataReader}=require('../src/azureMetadataReader');
const subscriptionId='11111111-2222-3333-4444-555555555555',resourceGroup='rg-clean';
const id='/subscriptions/'+subscriptionId+'/resourceGroups/'+resourceGroup+'/providers/Microsoft.Web/sites/clean-nano-ai-bridge';
function collector(apps,deployments){return createArmMetadataCollector({subscriptionId,resourceGroup,armGet:async path=>path.includes('/deployments?')?deployments:apps});}
test('injectable into existing reader, no SHA or RBAC success inferred',async()=>{
 const c=collector({value:[{id,name:'clean-nano-ai-bridge'}]},{value:[{id:id+'/deployments/abc',name:'abc',properties:{active:true,status:4}}]});
 const out=await createAzureMetadataReader({collectMetadata:c}).readDeploymentMetadata();
 assert.equal(out.resourceIdMatched,true);assert.equal(out.deploymentEntries.length,1);
 assert.equal(out.diagnostic.checks.independentDeploymentSha,'unconfirmed');
 assert.equal(out.diagnostic.checks.effectiveRbac,'unconfirmed');
});
test('duplicate site blocks',async()=>{
 const c=collector({value:[{id,name:'clean-nano-ai-bridge'},{id,name:'clean-nano-ai-bridge'}]},{value:[]});
 const out=await createAzureMetadataReader({collectMetadata:c}).readDeploymentMetadata();
 assert.equal(out.status,'blocked');
});
test('partial paging blocks',async()=>{
 const c=collector({value:[{id,name:'clean-nano-ai-bridge'}]},{value:[],nextLink:'https://management.azure.com/next'});
 const out=await createAzureMetadataReader({collectMetadata:c}).readDeploymentMetadata();
 assert.equal(out.status,'blocked');
});
test('foreign deployment blocks',async()=>{
 const c=collector({value:[{id,name:'clean-nano-ai-bridge'}]},{value:[{id:id+'/slots/test/deployments/abc',name:'abc'}]});
 const out=await createAzureMetadataReader({collectMetadata:c}).readDeploymentMetadata();
 assert.equal(out.status,'blocked');
});
