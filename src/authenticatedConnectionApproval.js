'use strict';
// Authenticated principal boundary. This module NEVER trusts subjectId supplied
// in request body, query string, headers, or the approval utterance.
// The caller must inject a verified identity from a trusted auth middleware.
const {createDurableApprovalService}=require('./durableConnectionApproval');
function createAuthenticatedApprovalHandler({store,resolveVerifiedPrincipal}={}) {
 if(!store || typeof resolveVerifiedPrincipal!=='function') throw new TypeError('trusted_auth_provider_required');
 const approval=createDurableApprovalService(store);
 return Object.freeze({
  async consume({requestId,targetId,utterance,authContext}={}) {
   let principal;
   try {principal=await resolveVerifiedPrincipal(authContext);}
   catch {return {status:'BLOCKED',reason:'identity_verification_failed'};}
   if(!principal || principal.verified!==true ||
      typeof principal.subjectId!=='string' || !principal.subjectId ||
      typeof principal.issuer!=='string' || !principal.issuer ||
      typeof principal.tenantId!=='string' || !principal.tenantId)
     return {status:'BLOCKED',reason:'authenticated_principal_required'};
   // Auth provider is responsible for validating signature, issuer, audience,
   // tenant, expiry, token binding, and user session. Never parse raw JWT here.
   return approval.consume({requestId,targetId,utterance,subjectId:principal.subjectId});
  }
 });
}
module.exports={createAuthenticatedApprovalHandler};
