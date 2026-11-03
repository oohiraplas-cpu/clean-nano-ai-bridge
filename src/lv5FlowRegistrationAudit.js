'use strict';
// Read-only audit of Bridge registration prerequisites. No environment writes.
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function auditRegistration({environmentId,flows,registeredIds,configuredIds}={}) {
 const block=reason=>Object.freeze({status:'BLOCKED',reason,executionAllowed:false});
 if(!GUID.test(environmentId||'')||!Array.isArray(flows)||!Array.isArray(registeredIds)||!Array.isArray(configuredIds))
  return block('scope_or_configuration_missing');
 if(![...registeredIds,...configuredIds].every(id=>GUID.test(id))) return block('invalid_registration_id');
 const inventory=new Map();
 for(const f of flows) {
  if(!f||!GUID.test(f.id||'')) return block('invalid_inventory_id');
  const key=f.id.toLowerCase();
  if(inventory.has(key)) return block('duplicate_inventory_id');
  inventory.set(key,f);
 }
 const registered=new Set(registeredIds.map(x=>x.toLowerCase()));
 const configured=new Set(configuredIds.map(x=>x.toLowerCase()));
 if(registered.size!==registeredIds.length||configured.size!==configuredIds.length) return block('duplicate_registration_id');
 if(![...registered,...configured].every(id=>inventory.has(id))) return block('unknown_registered_flow_id');
 const missing=[...registered].filter(id=>!configured.has(id));
 const extra=[...configured].filter(id=>!registered.has(id));
 if(missing.length||extra.length) return Object.freeze({status:'BLOCKED',reason:'registration_configuration_mismatch',missing,extra,executionAllowed:false});
 if(registered.size===0) return block('no_registered_flows');
 return Object.freeze({status:'INVENTORY_CONSISTENT',registeredCount:registered.size,executionAllowed:false,requiresSeparateAuthorization:true});
}
module.exports={auditRegistration};
