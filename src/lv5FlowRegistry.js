'use strict';
// Read-only inventory. Never registers triggers or invokes flows.
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function discoverFlows(flows,{environmentId,approvedIds=[]}={}) {
 if (!GUID.test(environmentId||'') || !Array.isArray(flows) || !Array.isArray(approvedIds) || flows.length>200)
  throw new Error('invalid inventory scope');
 const seen=new Set();
 return flows.map(flow=>{
  const id=flow&&flow.id;
  if (!GUID.test(id||'') || seen.has(id.toLowerCase())) throw new Error('invalid or duplicate flow ID');
  seen.add(id.toLowerCase());
  return Object.freeze({environmentId,id,name:String(flow.name||''),state:flow.state==='on'?'on':'off',
   registration:approvedIds.includes(id)?'REGISTERED':'DISCOVERED_UNAPPROVED',
   executionAllowed:false});
 });
}
module.exports={discoverFlows};
