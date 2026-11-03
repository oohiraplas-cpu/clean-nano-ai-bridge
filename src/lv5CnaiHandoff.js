'use strict';
// Transport-neutral CNAI -> ChatGPT handoff contract. No network calls or automatic execution.
const crypto=require('node:crypto');
const ALLOWED=new Set(['inspect','audit','plan','review','summarize']);
function prepareHandoff(input,{approvedTargets=[]}={}) {
 if (!input || typeof input!=='object' || Array.isArray(input)) throw new Error('invalid_request');
 const {requestId,origin,action,target,environmentId,instruction}=input;
 if (origin!=='CNAI' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId||'')) throw new Error('untrusted_origin_or_id');
 if (!ALLOWED.has(action)) throw new Error('action_not_read_only');
 if (typeof target!=='string' || !approvedTargets.includes(target)) throw new Error('target_not_registered');
 if (!/^[0-9a-f-]{36}$/i.test(environmentId||'')) throw new Error('environment_unverified');
 if (typeof instruction!=='string' || !instruction.trim() || instruction.length>2000) throw new Error('instruction_invalid');
 const payload=Object.freeze({schemaVersion:1,requestId,origin:'CNAI',action,target,environmentId,instruction:instruction.trim(),executionAllowed:false,requiresHumanApproval:true});
 const digest=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 return Object.freeze({status:'READY_FOR_VERIFIED_TRANSPORT',payload,digest});
}
module.exports={prepareHandoff,ALLOWED};
