'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { encryptRoster, decryptRoster } = require('../src/rosterCrypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const PLAIN = JSON.stringify([{ no: 1, name: '架空 一郎', category: '一般社員', email: 'ichiro@example.test' }]);

test('round trip with the PEM and with the base64 form stored in Azure', () => {
  const env = encryptRoster(PLAIN, publicKey);
  assert.equal(decryptRoster(env, privateKey), PLAIN);
  assert.equal(decryptRoster(env, Buffer.from(privateKey).toString('base64')), PLAIN);
});

test('the envelope contains no plaintext', () => {
  const text = JSON.stringify(encryptRoster(PLAIN, publicKey));
  for (const s of ['架空', 'example.test', 'ichiro']) assert.ok(!text.includes(s), s);
});

test('a wrong key or a tampered envelope fails instead of returning data', () => {
  const env = encryptRoster(PLAIN, publicKey);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.throws(() => decryptRoster(env, other.privateKey));
  const bytes = Buffer.from(env.data, 'base64'); bytes[0] ^= 1;
  assert.throws(() => decryptRoster({ ...env, data: bytes.toString('base64') }, privateKey));
  assert.throws(() => decryptRoster({ ...env, v: 2 }, privateKey), /unsupported/);
});
