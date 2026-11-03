'use strict';
// Isolated, read-only coordinator. No implicit approval and no mutation dispatch.
const READ_ACTIONS = new Set(['get','list','inspect','health','compare','audit']);
const DOMAINS = new Set(['powerapps','powerautomate','sharepoint','dataverse','copilotstudio','powerpages','powerbi','forms','admin']);
async function runReadBatch(requests,{handlers={},authorize,maxConcurrent=3}={}) {
 if (!Array.isArray(requests) || requests.length>50 || !Number.isInteger(maxConcurrent) || maxConcurrent<1 || maxConcurrent>6)
  throw new Error('invalid batch or concurrency');
 if (typeof authorize!=='function') throw new Error('authorization callback required');
 const results = Array(requests.length);
 let cursor=0;
 async function worker() {
  while (cursor<requests.length) {
   const index=cursor++, req=requests[index];
   if (!req || !DOMAINS.has(req.domain) || !READ_ACTIONS.has(req.action) || typeof req.target!=='string' || !req.target.trim()) {
    results[index]={status:'BLOCKED',reason:'invalid_or_mutating_request'}; continue;
   }
   try {
    if (await authorize(req)!==true) {results[index]={status:'BLOCKED',reason:'authorization_unverified'};continue;}
    const handler=handlers[req.domain];
    if (typeof handler!=='function') {results[index]={status:'BLOCKED',reason:'handler_unavailable'};continue;}
    const value=await handler(Object.freeze({...req}));
    results[index]={status:'OBSERVED',value};
   } catch(e) {results[index]={status:'BLOCKED',reason:'handler_error',error:String(e&&e.message||e)};}
  }
 }
 await Promise.all(Array.from({length:Math.min(maxConcurrent,requests.length)},()=>worker()));
 return results;
}
module.exports={runReadBatch,READ_ACTIONS};
