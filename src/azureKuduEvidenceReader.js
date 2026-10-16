'use strict';
const SHA=/^[a-f0-9]{40}$/i;
function createAzureKuduEvidenceReader({request,getArmToken,getKuduToken,resourceId}={}){
 if(typeof request!=='function'||typeof getArmToken!=='function'||typeof getKuduToken!=='function'||!/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge$/i.test(resourceId||'')) throw new TypeError('configuration_unverified');
 async function read(url,tokenFn){try{const token=await tokenFn();if(!token)return null;const r=await request({method:'GET',url,headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error'});return r?.status===200?r.data:null;}catch{return null;}}
 return Object.freeze({async inspect(expectedSha){
 if(!SHA.test(expectedSha||''))return {status:'blocked',reason:'expected_sha_invalid'};
 const arm=await read('https://management.azure.com'+resourceId+'?api-version=2023-12-01',getArmToken);
 const kudu=await read('https://clean-nano-ai-bridge.scm.azurewebsites.net/api/deployments',getKuduToken);
 if(String(arm?.id||'').toLowerCase()!==resourceId.toLowerCase()||!Array.isArray(kudu))return {status:'blocked',reason:'azure_or_kudu_unverified',runtimeShaVerified:false};
 const historyMatched=kudu.some(d=>d?.active===true&&SHA.test(d?.commitSha||'')&&d.commitSha.toLowerCase()===expectedSha.toLowerCase());
 return {status:'blocked',reason:'runtime_artifact_attestation_missing',armVerified:true,kuduVerified:true,historyMatched,runtimeShaVerified:false};
 }});
}
module.exports={createAzureKuduEvidenceReader};
