'use strict';
// Explicitly opt-in collector for AzureMetadataReader({collectMetadata}).
// Does not discover credentials, change configuration, or infer runtime SHA.
function createArmMetadataCollector({armGet,subscriptionId,resourceGroup}={}) {
 if(typeof armGet!=='function'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(subscriptionId||'')||typeof resourceGroup!=='string'||!/^[a-zA-Z0-9_.()\-]{1,90}$/.test(resourceGroup)) throw new TypeError('arm_collector_unconfigured');
 const prefix='/subscriptions/'+subscriptionId;
 const siteId=prefix+'/resourceGroups/'+resourceGroup+'/providers/Microsoft.Web/sites/clean-nano-ai-bridge';
 const listPath=prefix+'/providers/Microsoft.Web/sites?api-version=2023-12-01';
 const historyPath=siteId+'/deployments?api-version=2023-12-01';
 const fail=(stage,reason)=>Object.assign(new Error('azure_metadata_unavailable'),{metadataFailures:[{stage,reason}]});
 return async function collectMetadata() {
  let apps;
  try{apps=await armGet(listPath);}catch{throw fail('target_lookup','arm_read_unavailable');}
  if(!Array.isArray(apps?.value)||typeof apps.nextLink==='string')throw fail('target_lookup','invalid_or_incomplete_response');
  const matching=apps.value.filter(v=>v?.name==='clean-nano-ai-bridge');
  if(matching.length!==1)throw fail('target_lookup','target_not_unique');
  const app=matching[0];
  if(typeof app.id!=='string'||app.id.toLowerCase()!==siteId.toLowerCase())throw fail('target_lookup','resource_id_mismatch');
  let history;
  try{history=await armGet(historyPath);}catch{throw fail('deployment_history','arm_read_unavailable');}
  if(!Array.isArray(history?.value)||typeof history.nextLink==='string')throw fail('deployment_history','invalid_or_incomplete_response');
  if(history.value.some(d=>!d||typeof d!=='object'||typeof d.id!=='string'||!d.id.toLowerCase().startsWith((siteId+'/deployments/').toLowerCase())))throw fail('deployment_history','resource_id_mismatch');
  return Object.freeze({resourceIdMatched:true,armResourceId:app.id,armObservedIndependently:true,
    managedIdentityAssigned:false,managedIdentityObservedIndependently:false,
    deploymentMetadataAccessible:true,deploymentEntries:history.value.slice(0,30).map(d=>({
      deploymentId:typeof d.name==='string'?d.name.slice(0,100):null,
      active:d.properties?.active===true,status:Number.isInteger(d.properties?.status)?d.properties.status:null,
      receivedTime:typeof d.properties?.receivedTime==='string'?d.properties.receivedTime.slice(0,40):null
    })),metadataFailures:[],independentAzureShaVerified:false,effectiveRbacVerifiedIndependently:false});
 };
}
module.exports={createArmMetadataCollector};
