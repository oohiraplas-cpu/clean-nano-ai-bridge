'use strict';
// Pure preflight for SharePoint ETag concurrency. No Graph calls or writes.
function assessEtagWrite({expectedEtag,currentEtag,approval,environment,requestId}={}) {
 const block=reason=>Object.freeze({status:'BLOCKED',reason,writeAllowed:false});
 if(environment!=='isolated') return block('environment_unverified');
 if(typeof requestId!=='string'||!requestId.trim()) return block('request_identity_missing');
 if(typeof expectedEtag!=='string'||!/^".+,.+"$/.test(expectedEtag)) return block('expected_etag_invalid');
 if(typeof currentEtag!=='string'||!/^".+,.+"$/.test(currentEtag)) return block('current_etag_invalid');
 if(expectedEtag!==currentEtag) return block('etag_conflict');
 if(!approval||approval.verified!==true||approval.requestId!==requestId) return block('human_approval_unverified');
 return Object.freeze({status:'ELIGIBLE_FOR_SEPARATE_AUTHORIZATION',reason:'conditional_if_match_required',writeAllowed:false,requiredIfMatch:expectedEtag});
}
module.exports={assessEtagWrite};
