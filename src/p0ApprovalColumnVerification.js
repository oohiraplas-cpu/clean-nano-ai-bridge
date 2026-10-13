'use strict';
// Read-only schema probe. Internal field names must be explicit, unique, and complete.
const REQUIRED = Object.freeze(['requestId','stepIndex','tool','status','approver','approvedAt','revoked','targetSha','environmentId','appId','changeHash','approvalStage']);
async function verifyApprovalColumns({reader,siteId,listId,fieldMap}={}) {
 const deny=reason=>Object.freeze({verified:false,reason});
 if(!reader || typeof reader.listColumns!=='function' || !siteId || !listId || !fieldMap) return deny('schema_probe_not_configured');
 if(!REQUIRED.every(key=>typeof fieldMap[key]==='string' && fieldMap[key].trim())) return deny('field_map_incomplete');
 const names=REQUIRED.map(key=>fieldMap[key]);
 if(new Set(names).size!==names.length) return deny('field_map_duplicate');
 let result;try{result=await reader.listColumns({siteId,listId});}catch{return deny('columns_unavailable');}
 if(!result || result.status!=='ok' || result.siteId!==siteId || result.listId!==listId ||
 !Array.isArray(result.columns) || result.columns.some(c=>!c || typeof c.name!=='string')) return deny('columns_invalid');
 const available=new Set(result.columns.map(c=>c.name));
 if(!names.every(n=>available.has(n))) return deny('internal_names_unverified');
 return Object.freeze({verified:true,siteId,listId,verifiedColumnCount:names.length});
}
module.exports={verifyApprovalColumns,REQUIRED};
