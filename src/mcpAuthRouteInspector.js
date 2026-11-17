'use strict';
// Pure read-only MCP auth contract. It never inspects or emits secret values.
const ROUTES=Object.freeze({
 '/mcp':Object.freeze({key:'MCP_API_KEY',auth:'api_key',missingStatus:503}),
 '/connector/mcp':Object.freeze({key:'CONNECTOR_API_KEY',auth:'api_key',missingStatus:404}),
 '/recovery/mcp':Object.freeze({key:'RECOVERY_ENTRA_TENANT_ID',auth:'entra_jwt',missingStatus:404})
});
function inspectMcpRoute({path,method='POST',authScheme}={}){
 const route=Object.prototype.hasOwnProperty.call(ROUTES,path)?ROUTES[path]:null;
 if(!route)return {status:'BLOCKED',reason:'unknown_mcp_path',verified:false};
 if(method!=='POST')return {status:'BLOCKED',reason:'mcp_method_mismatch',verified:false};
 const accepted=route.auth==='api_key'?['x-api-key','bearer_api_key','query_api_key']:['entra_bearer_jwt'];
 if(!accepted.includes(authScheme))return {status:'BLOCKED',reason:'auth_scheme_mismatch',expected:route.auth,verified:false};
 return {status:'PARTIAL',reason:'static_route_contract_only',expected:route.auth,missingKeyHttpStatus:route.missingStatus,verified:false};
}
module.exports={inspectMcpRoute};
