'use strict';
// Azure App Service Managed Identity ARM token provider.
// Credentials remain inside the process; never return token values to MCP clients.
const ENDPOINTS = ['http://169.254.169.254/metadata/identity/oauth2/token'];
function createArmManagedIdentityTokenProvider({ fetchImpl, env = process.env } = {}) {
 if (typeof fetchImpl !== 'function') throw new TypeError('fetch_required');
 return async function getArmToken() {
   const endpoint = env.IDENTITY_ENDPOINT || env.MSI_ENDPOINT;
   const header = env.IDENTITY_HEADER || env.MSI_SECRET;
   const modern = Boolean(env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER);
   if (!endpoint || !header) throw new Error('managed_identity_unavailable');
   const parsed = new URL(endpoint);
   if (parsed.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(parsed.hostname))
     throw new Error('managed_identity_endpoint_untrusted');
   const url = new URL(parsed.href);
   url.searchParams.set('resource','https://management.azure.com/');
   url.searchParams.set('api-version', modern ? '2019-08-01' : '2017-09-01');
   if (env.AZURE_CLIENT_ID) url.searchParams.set('client_id',env.AZURE_CLIENT_ID);
   const response = await fetchImpl(url.href,{method:'GET',redirect:'error',headers:modern?{'X-IDENTITY-HEADER':header}:{Secret:header}});
   if (!response?.ok) throw new Error('managed_identity_token_request_failed');
   const body = await response.json();
   if (typeof body?.access_token !== 'string' || !body.access_token) throw new Error('managed_identity_token_missing');
   return body.access_token;
 };
}
module.exports={createArmManagedIdentityTokenProvider};
