'use strict';
// Graph transport for an EXISTING SharePoint approval list. No network calls
// occur until the injected authorized fetch is invoked by a trusted caller.
// Requires a verified unique requestId field and least-privilege Graph token.
function createGraphApprovalTransport({siteId,listId,requestIdColumn,fetchImpl,accessToken}={}){
 const guid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
 const column=/^[A-Za-z_][A-Za-z0-9_]*$/;
 if(typeof siteId!=='string'||!siteId||!guid.test(listId||'')||
    !column.test(requestIdColumn||'')||typeof fetchImpl!=='function'||
    typeof accessToken!=='function') throw new TypeError('verified_graph_configuration_required');
 const base='https://graph.microsoft.com/v1.0/sites/'+encodeURIComponent(siteId)+'/lists/'+listId+'/items';
 async function headers(extra={}){
  const token=await accessToken();
  if(typeof token!=='string'||!token) throw Error('graph_auth_unavailable');
  return {authorization:'Bearer '+token,accept:'application/json',...extra};
 }
 async function fetchItem(requestId){
  if(typeof requestId!=='string'||!requestId||requestId.length>256)throw Error('invalid_request_id');
  const filter='fields/'+requestIdColumn+" eq '"+requestId.replace(/'/g,"''")+"'";
  const url=base+'?$expand=fields&$filter='+encodeURIComponent(filter)+'&$top=2';
  const response=await fetchImpl(url,{method:'GET',headers:await headers(),redirect:'error'});
  if(!response||response.status!==200)throw Error('graph_read_failed');
  const body=await response.json();
  if(!body||!Array.isArray(body.value)||body.value.length>1||
     body['@odata.nextLink'])throw Error('approval_lookup_ambiguous');
  if(body.value.length===0)return null;
  const row=body.value[0];
  const etag=row['@odata.etag']||row.eTag;
  if(typeof row.id!=='string'||!/^[1-9][0-9]*$/.test(row.id)||
     typeof etag!=='string'||!etag||!row.fields||typeof row.fields!=='object')
     throw Error('approval_row_invalid');
  return {id:row.id,etag,fields:row.fields};
 }
 async function patchItem({itemId,ifMatch,fields}={}){
  if(typeof itemId!=='string'||!/^[1-9][0-9]*$/.test(itemId)||
     typeof ifMatch!=='string'||!/^W?\/"[^"\r\n]+"$/.test(ifMatch)||
     !fields||typeof fields!=='object'||Array.isArray(fields)||
     Object.keys(fields).length!==1||Object.values(fields)[0]!=='consumed')
     throw Error('unsafe_approval_patch');
  const response=await fetchImpl(base+'/'+itemId+'/fields',{
   method:'PATCH',redirect:'error',
   headers:await headers({'content-type':'application/json','If-Match':ifMatch}),
   body:JSON.stringify(fields)
  });
  if(!response||![200,204,409,412].includes(response.status))throw Error('graph_write_failed');
  return {status:response.status};
 }
 return Object.freeze({fetchItem,patchItem});
}
module.exports={createGraphApprovalTransport};
