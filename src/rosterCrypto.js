'use strict';
// Hybrid encryption for a roster that has to cross a PUBLIC repository (see docs in .github/workflows/bridge-import-roster.yml).
//   - a random 256-bit AES-GCM key encrypts the roster;
//   - that key is wrapped with an RSA public key (OAEP, SHA-256).
// The RSA private key lives only in Azure App Service settings (ROSTER_PRIVATE_KEY, base64 of the PEM) and is read inside a
// workflow run, masked. This file never prints rows or keys.
const crypto = require('node:crypto');

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');

function encryptRoster(plaintext, publicKeyPem) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
  return { v: 1, alg: 'RSA-OAEP-256+A256GCM', wrappedKey: b64(wrappedKey), iv: b64(iv), tag: b64(tag), data: b64(data) };
}

// privateKey: the PEM text, or base64 of the PEM (as stored in the Azure setting).
function decryptRoster(envelope, privateKey) {
  if (!envelope || envelope.v !== 1) throw new Error('unsupported envelope');
  const pem = String(privateKey).includes('BEGIN') ? String(privateKey) : unb64(privateKey).toString('utf8');
  const aesKey = crypto.privateDecrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, unb64(envelope.wrappedKey));
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, unb64(envelope.iv));
  decipher.setAuthTag(unb64(envelope.tag));
  return Buffer.concat([decipher.update(unb64(envelope.data)), decipher.final()]).toString('utf8');
}

module.exports = { encryptRoster, decryptRoster };
