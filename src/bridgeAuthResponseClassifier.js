'use strict';

// Pure, secretless classification of observed MCP HTTP responses.
// Never guesses which upstream layer returned a generic 401.
function classifyBridgeAuthResponse({ path, status, body, headers } = {}) {
  const validPaths = ['/mcp', '/connector/mcp', '/recovery/mcp'];
  if (!validPaths.includes(path) || !Number.isInteger(status) || status < 100 || status > 599) {
    return Object.freeze({ status: 'BLOCKED', reason: 'invalid_observation', verified: false });
  }
  // Caller must supply a trusted, already-redacted response body; we inspect only
  // the exact known application error marker and never return input data.
  const error = body && typeof body === 'object' && !Array.isArray(body) ? body.error : undefined;
  // This marker is not cryptographic proof of origin: a proxy can reproduce it.
  const app401 = status === 401 && error === '認証に失敗しました';
  const missingMain = path === '/mcp' && status === 503 && error === '認証キーが未設定のため利用できません';
  const missingConnector = path === '/connector/mcp' && status === 404 && error === 'コネクタ用エンドポイントは無効です';
  const authHeader = headers && typeof headers === 'object' ? (headers['www-authenticate'] || headers['WWW-Authenticate']) : undefined;
  const oauthChallenge = path === '/recovery/mcp' && status === 401 && typeof authHeader === 'string'
    && /^Bearer(?:\s|$)/i.test(authHeader);
  const reason = app401 ? 'bridge_api_key_rejection_candidate'
    : missingMain ? 'main_key_not_configured'
    : missingConnector ? 'connector_key_not_configured'
    : oauthChallenge ? 'recovery_oauth_challenge'
    : status === 401 ? '401_origin_unverified'
    : status === 403 ? '403_origin_unverified'
    : 'insufficient_auth_evidence';
  return Object.freeze({
    status: 'PARTIAL', reason, verified: false,
    layer: app401 || missingMain || missingConnector || oauthChallenge ? 'application_signature_unverified' : 'unknown',
    readOnly: true
  });
}
module.exports = { classifyBridgeAuthResponse };
