'use strict';
// Safe Dataverse GET-only transport. Reuses the existing Power Apps/Automate
// Entra app registration settings, without importing write-capable clients.
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATHS=[
 /^canvasapps\?\$select=canvasappid,name&\$top=1$/,
 /^workflows\?\$select=workflowid,name&\$filter=category%20eq%205&\$top=1$/,
 /^canvasapps\([0-9a-f-]{36}\)\?\$select=canvasappid,name$/,
 /^workflows\([0-9a-f-]{36}\)\?\$select=workflowid,name,statecode$/
];
function createDataverseReadOnlyClient(config={},fetchImpl=globalThis.fetch){
 const {orgUrl,tenantId,clientId,clientSecret}=config;
 let origin;
 try {origin=new URL(orgUrl);} catch {throw new TypeError('dataverse_configuration_required');}
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||
    origin.pathname!=='/'&&origin.pathname!==''||
    !/^[a-z0-9-]+\.crm(?:[0-9]+)?\.dynamics\.com$/i.test(origin.hostname)||
    !GUID.test(tenantId||'')||!GUID.test(clientId||'')||
    typeof clientSecret!=='string'||!clientSecret||typeof fetchImpl!=='function')
  throw new TypeError('dataverse_configuration_required');
 const root=origin.origin;
 let cached=null,expires=0;
 async function token(){
  if(cached&&Date.now()<expires-60000)return cached;
  const response=await fetchImpl('https://login.microsoftonline.com/'+tenantId+'/oauth2/v2.0/token',{
   method:'POST',redirect:'error',
   headers:{'content-type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret,scope:root+'/.default'}).toString()
  });
  if(!response||response.status!==200)throw Error('dataverse_auth_failed');
  const body=await response.json();
  if(!body||typeof body.access_token!=='string'||!body.access_token||
     !Number.isFinite(body.expires_in)||body.expires_in<=60)throw Error('dataverse_auth_invalid');
  cached=body.access_token;expires=Date.now()+body.expires_in*1000;
  return cached;
 }
 return Object.freeze({
  async get(path){
   if(typeof path!=='string'||!PATHS.some(p=>p.test(path)))throw Error('read_path_not_allowed');
   const response=await fetchImpl(root+'/api/data/v9.2/'+path,{
    method:'GET',redirect:'error',
    headers:{authorization:'Bearer '+await token(),accept:'application/json'}
   });
   if(!response||response.status!==200)throw Error('dataverse_read_failed');
   return response.json();
  }
 });
}
module.exports={createDataverseReadOnlyClient};
