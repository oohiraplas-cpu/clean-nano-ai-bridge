'use strict';
// Read-only configuration preflight for existing Power Platform credentials.
// Never returns credential values, client IDs, tenant IDs or service URLs.
function inspectPowerPlatformAuth(env={}){
 const nonempty=k=>typeof env[k]==='string'&&env[k].trim().length>0;
 const tenant=nonempty('POWERAPPS_TENANT_ID')||nonempty('AZURE_TENANT_ID');
 const client=nonempty('POWERAPPS_CLIENT_ID')||nonempty('AZURE_CLIENT_ID');
 const secret=nonempty('POWERAPPS_CLIENT_SECRET')||nonempty('AZURE_CLIENT_SECRET');
 const org=env.POWERAPPS_ORG_URL||env.DATAVERSE_URL||'';
 const validOrg=typeof org==='string'&&/^https:\/\/[a-z0-9.-]+\.dynamics\.com\/?$/i.test(org);
 const missing=[];
 if(!tenant)missing.push('tenant_id');
 if(!client)missing.push('client_id');
 if(!secret)missing.push('client_credential');
 if(!validOrg)missing.push('verified_dataverse_org_url');
 return Object.freeze({status:missing.length?'BLOCKED':'PARTIAL',
  reason:missing.length?'existing_auth_configuration_incomplete':'configured_not_authenticated',
  missing,verified:false,readOnly:true});
}
module.exports={inspectPowerPlatformAuth};
