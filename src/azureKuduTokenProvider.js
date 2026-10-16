'use strict';
// Read-only Kudu authentication boundary. No publishing credentials, Basic auth,
// or token values are ever returned in audit results.
function createKuduTokenProvider({getAccessToken, audience='https://management.azure.com/'}={}) {
  if (typeof getAccessToken !== 'function') throw new TypeError('token_provider_required');
  if (audience !== 'https://management.azure.com/') throw new TypeError('audience_unapproved');
  return async function getKuduToken() {
    try {
      const token = await getAccessToken(audience);
      if (typeof token !== 'string' || !token.trim()) throw new Error('missing');
      return token;
    } catch {
      throw new Error('kudu_aad_auth_unverified');
    }
  };
}
module.exports={createKuduTokenProvider};
