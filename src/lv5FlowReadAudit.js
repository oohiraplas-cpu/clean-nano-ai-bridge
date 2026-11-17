'use strict';
// Pure READ inventory audit. This module cannot invoke or modify Power Automate flows.
const {discoverFlows}=require('./lv5FlowRegistry');
function auditFlowInventory(flows,{environmentId,approvedIds=[]}={}) {
 const inventory=discoverFlows(flows,{environmentId,approvedIds});
 const nameCounts=new Map();
 for(const f of inventory) nameCounts.set(f.name,(nameCounts.get(f.name)||0)+1);
 const entries=inventory.map(f=>Object.freeze({...f,duplicateName:nameCounts.get(f.name)>1}));
 return Object.freeze({
  status:'READ_ONLY_AUDIT',environmentId,total:entries.length,
  active:entries.filter(f=>f.state==='on').length,
  unapproved:entries.filter(f=>f.registration==='DISCOVERED_UNAPPROVED').length,
  duplicateNames:[...nameCounts].filter(([,n])=>n>1).map(([name])=>name),
  executionAllowed:false,entries:Object.freeze(entries)
 });
}
module.exports={auditFlowInventory};
