'use strict';
// Diagnose configuration compatibility without reading or exposing secret values.
const GUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function inspectPowerPlatformAuth(env={}){
 const first=(a,b)=>typeof env[a]==='string'&&env[a].trim()?env[a]:env[b];
 const tenant=first('POWERAPPS_TENANT_ID','AZURE_TENANT_ID');
 const client=first('POWERAPPS_CLIENT_ID','AZURE_CLIENT_ID');
 const secret=first('POWERAPPS_CLIENT_SECRET','AZURE_CLIENT_SECRET');
 const org=first('POWERAPPS_ORG_URL','DATAVERSE_URL');
 let validOrg=false;
 try{
  const u=new URL(org);
  validOrg=u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&
   (u.pathname==='/'||u.pathname==='')&&
   /^[a-z0-9-]+\.crm(?:[0-9]+)?\.dynamics\.com$/i.test(u.hostname);
 }catch{}
 const missing=[];
 if(!GUID.test(tenant||''))missing.push('valid_tenant_id');
 if(!GUID.test(client||''))missing.push('valid_client_id');
 if(typeof secret!=='string'||!secret.trim())missing.push('client_credential');
 if(!validOrg)missing.push('verified_dataverse_org_url');
 return Object.freeze({status:missing.length?'BLOCKED':'PARTIAL',
  reason:missing.length?'existing_auth_configuration_incomplete':'configured_not_authenticated',
  missing,verified:false,readOnly:true});
}
module.exports={inspectPowerPlatformAuth};
