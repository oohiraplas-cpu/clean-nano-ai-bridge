const assert = require('node:assert/strict');
const test = require('node:test');
const { maskSecrets, maskDeep, containsLikelySecret, MASK } = require('../src/secretMasking');

test('Bearerトークン・GitHubトークン・JWT・Authorizationヘッダーをマスクする', () => {
  const ghp = `ghp_${'a'.repeat(30)}`;
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
  const text = `Authorization: Bearer abcdefghijklmnop\ntoken ${ghp}\njwt ${jwt}\ngithub_pat_${'b'.repeat(30)}`;
  const masked = maskSecrets(text);
  assert.ok(!masked.includes('abcdefghijklmnop'));
  assert.ok(!masked.includes(ghp));
  assert.ok(!masked.includes(jwt));
  assert.ok(!masked.includes('github_pat_'));
  assert.ok(masked.includes(MASK));
});

test('接続文字列・SASのsig・環境変数形式の秘密値をマスクする', () => {
  const masked = maskSecrets([
    'Server=tcp:db.example.net;Database=app;User Id=admin;Password=p4ss-w0rd!;',
    'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=KEY123abc==;EndpointSuffix=core.windows.net',
    'https://flow.example.com/trigger?api-version=1&sig=SECRETSIG123&sv=1',
    'MY_API_KEY=xyz-999 and CLIENT_SECRET: topsecretvalue'
  ].join('\n'));
  for (const leaked of ['p4ss-w0rd!', 'KEY123abc==', 'SECRETSIG123', 'xyz-999', 'topsecretvalue']) {
    assert.ok(!masked.includes(leaked), `${leaked} が残っています`);
  }
});

test('設定済みの秘密値そのもの（extraSecrets）をどこに現れてもマスクする', () => {
  const masked = maskSecrets('token=plain-configured-secret-value in the middle of text', ['plain-configured-secret-value']);
  assert.ok(!masked.includes('plain-configured-secret-value'));
});

test('通常の文章・短い値は変更しない', () => {
  assert.equal(maskSecrets('status ok, a=b;c=d; ビルド成功'), 'status ok, a=b;c=d; ビルド成功');
  assert.equal(maskSecrets(undefined), undefined);
});

test('maskDeepは入れ子のオブジェクト・配列と秘密っぽいキーの値をマスクする', () => {
  const result = maskDeep({
    password: 'x', note: 'Bearer zzzzzzzzzzzz', nested: [{ client_secret: 'y', ok: 'fine' }], count: 3
  });
  assert.equal(result.password, MASK);
  assert.ok(!result.note.includes('zzzzzzzzzzzz'));
  assert.equal(result.nested[0].client_secret, MASK);
  assert.equal(result.nested[0].ok, 'fine');
  assert.equal(result.count, 3);
});

test('containsLikelySecretは強いパターンだけを検出し、通常のPower Fxは検出しない', () => {
  assert.equal(containsLikelySecret(`x: ghp_${'c'.repeat(30)}`), true);
  assert.equal(containsLikelySecret('Fill: =RGBA(0, 18, 107, 1)\nText: ="トークンを入力"'), false);
});
