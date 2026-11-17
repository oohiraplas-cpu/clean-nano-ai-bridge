'use strict';
// Static configuration diagnosis only: no secret values, calls, or mutations.
function diagnoseBridgeAuthConfig(env={}){
 const configured=k=>typeof env[k]==='string'&&env[k].length>0;
 const main=configured('MCP_API_KEY');
 const connector=configured('CONNECTOR_API_KEY');
 const result={
  status:main&&connector?'PARTIAL':'BLOCKED',
  reason:!main?'main_mcp_key_missing':!connector?'connector_mcp_key_missing':'key_presence_not_runtime_verified',
  mainMcpConfigured:main,connectorMcpConfigured:connector,
  verified:false,readOnly:true
 };
 return Object.freeze(result);
}
module.exports={diagnoseBridgeAuthConfig};
