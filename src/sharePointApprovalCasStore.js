'use strict';
// ETag-backed SharePoint approval CAS adapter. Not wired to production.
// Requires a dedicated pre-existing list with verified internal field names,
// least-privilege auth and unique request IDs. No list creation is performed.
function createSharePointApprovalCasStore({fetchItem,patchItem,fieldMap}={}) {
 const required=['requestId','status','version','source','presentedToUser','subjectId','targetId','service','action','expiresAt'];
 if(typeof fetchItem!=='function' || typeof patchItem!=='function' ||
   !fieldMap || required.some(k=>typeof fieldMap[k]!=='string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldMap[k])) ||
   new Set(required.map(k=>fieldMap[k])).size!==required.length)
   throw new TypeError('verified_approval_schema_required');
 const normalize=item=>{
  if(!item || typeof item.id!=='string' || !item.id ||
     typeof item.etag!=='string' || !item.etag || !item.fields ||
     typeof item.fields!=='object') return null;
  const record={};
  for(const key of required) record[key]=item.fields[fieldMap[key]];
  if(typeof record.requestId!=='string' || !record.requestId) return null;
  return {itemId:item.id,etag:item.etag,record};
 };
 async function get(requestId){
  if(typeof requestId!=='string' || !requestId) throw Error('invalid_request_id');
  const item=normalize(await fetchItem(requestId));
  if(!item || item.record.requestId!==requestId) return null;
  return {...item.record,version:item.etag};
 }
 async function compareAndSwap(requestId,version,expected,next){
  if(typeof requestId!=='string' || !requestId ||
     typeof version!=='string' || !version ||
     expected!=='pending' || next!=='consumed') return false;
  const item=normalize(await fetchItem(requestId));
  if(!item || item.record.requestId!==requestId ||
     item.record.status!==expected || item.etag!==version) return false;
  // Must send If-Match with the ETag to the same SharePoint item.
  // 412/409 mean lost race; any other failure is fail-closed.
  const result=await patchItem({itemId:item.itemId,ifMatch:item.etag,fields:{[fieldMap.status]:next}});
  if(result && (result.status===412 || result.status===409)) return false;
  if(!result || (result.status!==200 && result.status!==204)) throw Error('approval_store_write_unverified');
  return true;
 }
 return Object.freeze({get,compareAndSwap});
}
module.exports={createSharePointApprovalCasStore};
