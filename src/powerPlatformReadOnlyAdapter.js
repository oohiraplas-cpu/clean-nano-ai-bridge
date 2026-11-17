'use strict';
// Read-only Power Apps / Power Automate diagnostic facade. It reuses the
// existing Dataverse client through dependency injection; no credentials,
// production writes, publishing, or arbitrary URLs are accepted.
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function createPowerPlatformReadOnlyAdapter({client,timeoutMs=10000}={}){
 if(!client||typeof client.get!=='function')throw new TypeError('existing_dataverse_client_required');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new TypeError('invalid_timeout');
 async function read(path,kind){
  let timer;
  try {
   const result=await Promise.race([
    Promise.resolve().then(()=>client.get(path)),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),timeoutMs);})
   ]);
   if(!result||typeof result!=='object')return {status:'BLOCKED',reason:'invalid_provider_response',verified:false};
   if(kind==='collection'&&!Array.isArray(result.value))return {status:'BLOCKED',reason:'invalid_provider_response',verified:false};
   return {status:'PASS',verified:true,kind,count:kind==='collection'?result.value.length:undefined};
  }catch{return {status:'BLOCKED',reason:'dataverse_read_or_auth_failed',verified:false};}
  finally{clearTimeout(timer);}
 }
 return Object.freeze({
  probePowerApps:()=>read('canvasapps?$select=canvasappid,name&$top=1','collection'),
  probePowerAutomate:()=>read('workflows?$select=workflowid,name&$filter=category%20eq%205&$top=1','collection'),
  inspectApp:(appId)=>GUID.test(appId||'')?read('canvasapps('+appId+')?$select=canvasappid,name','record'):Promise.resolve({status:'BLOCKED',reason:'invalid_app_id',verified:false}),
  inspectFlow:(flowId)=>GUID.test(flowId||'')?read('workflows('+flowId+')?$select=workflowid,name,statecode','record'):Promise.resolve({status:'BLOCKED',reason:'invalid_flow_id',verified:false})
 });
}
module.exports={createPowerPlatformReadOnlyAdapter};
