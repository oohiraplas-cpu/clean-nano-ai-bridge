'use strict';
// Isolated selection only; never registers, executes, or updates a flow.
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function selectFlowByGuid(flows,{flowId,environmentId,approvedIds=[]}={}) {
 const blocked=reason=>Object.freeze({status:'BLOCKED',reason,executionAllowed:false});
 if(!GUID.test(environmentId||'')||!GUID.test(flowId||'')||!Array.isArray(flows)||!Array.isArray(approvedIds)) return blocked('invalid_scope');
 if(!approvedIds.every(id=>GUID.test(id))) return blocked('invalid_allowlist');
 const allowed=new Set(approvedIds.map(id=>id.toLowerCase()));
 if(!allowed.has(flowId.toLowerCase())) return blocked('flow_id_not_approved');
 const matches=flows.filter(f=>f&&typeof f.id==='string'&&f.id.toLowerCase()===flowId.toLowerCase());
 if(matches.length!==1) return blocked('flow_id_missing_or_duplicate');
 if(matches[0].state!=='on') return blocked('flow_disabled');
 return Object.freeze({status:'DISCOVERED_APPROVED_ID',flowId:matches[0].id,environmentId,
  executionAllowed:false,requiresSeparateRegistration:true});
}
function selectFlowByName(flows,{name}={}) {
 const matches=Array.isArray(flows)?flows.filter(f=>f&&f.name===name):[];
 return Object.freeze({status:'BLOCKED',reason:matches.length>1?'ambiguous_flow_name':'name_based_selection_forbidden',executionAllowed:false});
}
module.exports={selectFlowByGuid,selectFlowByName};
