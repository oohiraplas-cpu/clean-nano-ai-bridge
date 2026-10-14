'use strict';
// Draft-only composition: caller must supply independently verified SharePoint IDs,
// internal field names, and the expected approval identity. No default column names.
const {ApprovalLedger,isApprovalLedgerConfigured}=require('./approvalLedger');
const {reserveSharePointApproval}=require('./productionEvidenceGateDraft');
const required=['requestId','stepIndex','tool','status','approver','approvedAt','revoked','planHash','executionId'];
function configured(config){
 return isApprovalLedgerConfigured(config) && typeof config.itemId==='string' && !!config.itemId.trim() &&
 required.every(k=>typeof config.fieldMap?.[k]==='string' && !!config.fieldMap[k].trim()) &&
 new Set(required.map(k=>config.fieldMap[k])).size===required.length &&
 typeof config.approvedValue==='string' && !!config.approvedValue &&
 typeof config.reservedValue==='string' && !!config.reservedValue &&
 config.approvedValue!==config.reservedValue;
}
async function reserveApprovalDraft({config,reader,writer,expected,executionId,now}={}){
 if(!configured(config)||typeof reader?._graphFetch!=='function'||
    typeof writer?.patchItemFieldsIfMatch!=='function'||!expected?.requestId||
    !Number.isInteger(expected.stepIndex)||!expected.tool||!expected.planHash||
    typeof expected.approver!=='string'||!expected.approver.trim()||
    typeof executionId!=='string'||!executionId.trim())
   return {status:'BLOCKED',reason:'approval_adapter_missing'};
 const {siteId,listId,itemId,fieldMap:m}=config;
 const read=async()=>{
   const raw=await reader._graphFetch(`/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}?$expand=fields`);
   if(!raw||String(raw.id)!==String(itemId)||!raw.fields||!(raw.eTag||raw['@odata.etag']))return null;
   const f=raw.fields;
   return {etag:raw.eTag||raw['@odata.etag'],requestId:f[m.requestId],stepIndex:f[m.stepIndex],
     tool:f[m.tool],status:f[m.status],approver:f[m.approver],approvedAt:f[m.approvedAt],
     revoked:f[m.revoked],planHash:f[m.planHash],executionId:f[m.executionId]};
 };
 try{
   const before=await read();
   if(!before||before.planHash!==expected.planHash||before.executionId||
      before.requestId!==expected.requestId||Number(before.stepIndex)!==expected.stepIndex||
      before.tool!==expected.tool||before.revoked!==false||
      before.status!==config.approvedValue||before.approver!==expected.approver)
     return {status:'BLOCKED',reason:'approval_not_available'};
   const ledger=new ApprovalLedger({config,fetchRows:async()=>[Object.fromEntries(
      ['requestId','stepIndex','tool','status','approver','approvedAt','revoked'].map(k=>
        [m[k],k==='status'?'承認':before[k]]))],now});
   const approved=await ledger.check({requestId:expected.requestId,stepIndex:expected.stepIndex,tool:expected.tool});
   if(!approved.approved)return {status:'BLOCKED',reason:approved.reason};
   // Re-read inside reserveSharePointApproval; only an ETag-guarded write can win.
   const result=await reserveSharePointApproval({
     readItem:async()=>{const item=await read();if(!item||item.requestId!==expected.requestId||Number(item.stepIndex)!==expected.stepIndex||item.tool!==expected.tool||item.approver!==before.approver||item.approvedAt!==before.approvedAt)return null;return {...item,
       status:item.status===config.approvedValue?'approved':item.status===config.reservedValue?'reserved':'unknown',
       revoked:item.revoked===false?false:true};},
     patchIfMatch:({etag,fields})=>writer.patchItemFieldsIfMatch(siteId,listId,itemId,{
       [m.executionId]:fields.executionId,[m.status]:config.reservedValue
     },etag),
     expected:{planHash:expected.planHash},executionId
   });
   return result;
 }catch{return {status:'BLOCKED',reason:'approval_api_unavailable'};}
}
module.exports={reserveApprovalDraft,configured};
