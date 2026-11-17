'use strict';
// Read-only integration adapter: reuses recoveryOAuth's existing Entra
// signature, issuer, audience, tenant, scope and fixed-user checks.
// The token must come from a trusted bearer authentication middleware.
const {createRecoveryAuth}=require('./recoveryOAuth');
function createRecoveryPrincipalResolver(env,fetchKeys){
 const auth=createRecoveryAuth(env,fetchKeys);
 if(!auth) return null;
 return Object.freeze({
  async resolveVerifiedPrincipal(authContext){
   if(!authContext || authContext.trustedMiddleware!==true ||
      typeof authContext.bearerToken!=='string')
     return null;
   return auth.verifiedPrincipal(authContext.bearerToken);
  }
 });
}
module.exports={createRecoveryPrincipalResolver};
