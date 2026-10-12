'use strict';
// Draft-only Graph approval store; not registered as a production tool.
// The column map is explicit: never guess SharePoint internal column names.
function createSharePointApprovalStore({writer,siteId,listId,fieldMap,verifyDirectoryHuman}={}) {
  const fields=['status','revoked','operation','siteId','listId','itemId','runtimeCommitSha','changeHash','approver','approvedAt','expiresAt','executionId','executionStatus','executionResult'];
  function assertConfigured(){
    if(!writer||typeof writer._getAccessToken!=='function'||typeof writer._fetch!=='function'||
       !writer.graphBaseUrl||!siteId||!listId||typeof verifyDirectoryHuman!=='function'||
       !fieldMap||fields.some(k=>typeof fieldMap[k]!=='string'||!fieldMap[k])) throw Error('APPROVAL_STORE_NOT_CONFIGURED');
  }
  async function request(id,method='GET',etag,body){
    assertConfigured();
    if(!/^[1-9][0-9]*$/.test(String(id))) throw Error('INVALID_APPROVAL_ID');
    const token=await writer._getAccessToken();
    const url=writer.graphBaseUrl+'/sites/'+encodeURIComponent(siteId)+'/lists/'+encodeURIComponent(listId)+'/items/'+encodeURIComponent(id)+'/fields';
    const headers={authorization:'Bearer '+token};
    if(method==='PATCH'){
      if(typeof etag!=='string'||!etag.trim()||etag==='*') throw Error('ETAG_REQUIRED');
      headers['If-Match']=etag;
      headers['content-type']='application/json';
    }
    const response=await writer._fetch(url,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok) throw Error('APPROVAL_GRAPH_'+response.status);
    return response;
  }
  return {
    assertConfigured,
    async read(id){
      const response=await request(id);
      const data=await response.json();
      const etag=response.headers.get('etag')||data['@odata.etag'];
      if(!etag||etag==='*') throw Error('APPROVAL_ETAG_MISSING');
      return {etag,record:Object.fromEntries(fields.map(k=>[k,data[fieldMap[k]]]))};
    },
    async patch(id,etag,values){
      const allowed=['executionId','executionStatus','executionResult'];
      if(!values||Object.keys(values).some(k=>!allowed.includes(k))) throw Error('RESERVATION_FIELDS_ONLY');
      await request(id,'PATCH',etag,Object.fromEntries(Object.entries(values).map(([k,v])=>[fieldMap[k],v])));
    },
    async verifyHuman(snapshot){
      // Independent directory/allowlist lookup; no caller-supplied approved flag.
      if(!snapshot?.record?.approver) return false;
      return await verifyDirectoryHuman(snapshot.record.approver)===true;
    }
  };
}
module.exports={createSharePointApprovalStore};
