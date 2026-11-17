'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyBridgeAuthResponse: classify } = require('../src/bridgeAuthResponseClassifier');

test('exact Bridge 401 identifies application rejection without exposing secrets', () => {
  const result = classify({ path: '/mcp', status: 401, body: { error: '認証に失敗しました', token: 'SECRET' } });
  assert.equal(result.reason, 'bridge_api_key_rejected');
  assert.equal(result.layer, 'application_signature');
  assert.equal(result.verified, false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
test('generic upstream 401 remains unverified', () => {
  assert.equal(classify({ path: '/mcp', status: 401, body: { error: 'Unauthorized' } }).reason, '401_origin_unverified');
});
test('missing main key is 503, not 401', () => {
  assert.equal(classify({ path: '/mcp', status: 503, body: { error: '認証キーが未設定のため利用できません' } }).reason, 'main_key_not_configured');
});
test('disabled connector is 404', () => {
  assert.equal(classify({ path: '/connector/mcp', status: 404, body: { error: 'コネクタ用エンドポイントは無効です' } }).reason, 'connector_key_not_configured');
});
test('OAuth challenge requires recovery route and Bearer challenge', () => {
  assert.equal(classify({ path: '/recovery/mcp', status: 401, headers: { 'www-authenticate': 'Bearer scope="mcp.access"' } }).reason, 'recovery_oauth_challenge');
  assert.equal(classify({ path: '/mcp', status: 401, headers: { 'www-authenticate': 'Bearer' } }).reason, '401_origin_unverified');
});
test('invalid observations fail closed', () => {
  for (const input of [{}, { path: '/other', status: 401 }, { path: '/mcp', status: 0 }, { path: '/mcp', status: '401' }]) {
    assert.equal(classify(input).status, 'BLOCKED');
  }
});
test('ambiguous and forbidden responses do not imply repaired auth', () => {
  for (const status of [200, 403, 429, 500, 502]) {
    const result = classify({ path: '/mcp', status });
    assert.equal(result.verified, false);
    assert.equal(result.layer, 'unknown');
  }
});
