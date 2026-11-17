'use strict';
// Read-only explanation of authentication failures, not an authentication bypass.
function classifyAuthFailure({service,httpStatus,transport,configured}={}){
 const services=['bridgeMcp','bridgeConnector','dataverse'];
 if(!services.includes(service))return {status:'BLOCKED',reason:'unknown_service',verified:false};
 if(![200,401,403,404,503].includes(httpStatus))return {status:'BLOCKED',reason:'unverified_http_status',verified:false};
 if(configured!==true)return {status:'BLOCKED',reason:'configuration_not_verified',verified:false};
 if(service==='dataverse'){
  if(transport!=='entra_client_credentials')return {status:'BLOCKED',reason:'dataverse_auth_transport_mismatch',verified:false};
 }else if(!['x-api-key','bearer_api_key','query_api_key'].includes(transport)){
  return {status:'BLOCKED',reason:'bridge_api_key_transport_mismatch',verified:false};
 }
 if(httpStatus===200)return {status:'PARTIAL',reason:'http_ok_authorized_operation_not_verified',verified:false};
 const reasons={401:'credential_rejected_or_upstream_auth',403:'permission_denied',404:'endpoint_missing_or_connector_disabled',503:'credential_not_configured_or_service_unavailable'};
 return {status:'BLOCKED',reason:reasons[httpStatus],verified:false};
}
module.exports={classifyAuthFailure};
