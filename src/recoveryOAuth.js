const { createPublicKey, verify } = require('node:crypto');

const path = '/recovery/mcp';
const metadataPath = '/.well-known/oauth-protected-resource' + path;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const microsoft = 'https://login.microsoftonline.com';

function createRecoveryAuth(env = process.env, fetchKeys = fetch) {
  const { RECOVERY_ENTRA_TENANT_ID: tenant, RECOVERY_ENTRA_CLIENT_ID: client,
    RECOVERY_ENTRA_AUDIENCE: audience, RECOVERY_ENTRA_USER_ID: user,
    RECOVERY_MCP_ORIGIN: origin } = env;
  if (![tenant, client, audience, user].every((id) => uuid.test(id || ''))) return null;
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin || '')) return null;

  const issuer = `${microsoft}/${tenant}/v2.0`;
  const scope = `api://${audience}/mcp.access`;
  const metadata = {
    resource: origin + path,
    authorization_servers: [issuer],
    scopes_supported: [scope],
    bearer_methods_supported: ['header']
  };
  let cachedKeys;
  let validUntil = 0;
  let pending;

  async function keys() {
    if (Date.now() < validUntil) return cachedKeys;
    pending ??= (async () => {
      const response = await fetchKeys(`${microsoft}/${tenant}/discovery/v2.0/keys`, {
        signal: AbortSignal.timeout(5000), redirect: 'error'
      });
      if (!response.ok) throw new Error('Entra signing keys unavailable');
      const body = await response.json();
      if (!Array.isArray(body.keys)) throw new Error('Invalid Entra signing keys');
      cachedKeys = body.keys;
      validUntil = Date.now() + 300_000;
      return cachedKeys;
    })().finally(() => { pending = undefined; });
    return pending;
  }

  async function authorized(token) {
    if (!token || token.length > 16384) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[\w-]+$/.test(part))) return false;
    try {
      const [headerPart, payloadPart, signature] = parts;
      const decode = (part) => JSON.parse(Buffer.from(part, 'base64url'));
      const header = decode(headerPart);
      const claim = decode(payloadPart);
      const now = Math.floor(Date.now() / 1000);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
      if (claim.iss !== issuer || claim.tid !== tenant || claim.ver !== '2.0'
        || claim.aud !== audience || claim.azp !== client || claim.oid !== user
        || !Number.isInteger(claim.exp) || claim.exp <= now
        || !Number.isInteger(claim.nbf) || claim.nbf > now
        || typeof claim.scp !== 'string' || !claim.scp.split(' ').includes('mcp.access')) return false;
      const key = (await keys()).find((entry) => entry.kid === header.kid
        && entry.kty === 'RSA' && entry.use === 'sig'
        && (!entry.issuer || entry.issuer.replace('{tenantid}', tenant) === issuer));
      return Boolean(key && verify('RSA-SHA256', Buffer.from(headerPart + '.' + payloadPart),
        createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url')));
    } catch {
      return false;
    }
  }

  async function middleware(req, res, next) {
    const token = /^Bearer ([\w.-]+)$/i.exec(req.get('authorization') || '')?.[1];
    if (await authorized(token)) return next();
    return res.status(401).set('WWW-Authenticate',
      `Bearer resource_metadata="${origin + metadataPath}", scope="${scope}"`)
      .json({ error: 'Recovery authentication required' });
  }
  return { metadata, middleware };
}

module.exports = { createRecoveryAuth, path, metadataPath };
