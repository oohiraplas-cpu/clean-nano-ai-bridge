'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateImageMediaDraft } = require('../src/imageMediaValidationDraft');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAt8AAAAASUVORK5CYII=';
const sha = crypto.createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex');
test('valid PNG metadata and digest are deterministic and do not expose image bytes', () => {
 const result = validateImageMediaDraft({base64Content:PNG,contentType:'image/png',expectedSha256:sha});
 assert.equal(result.status,'PASS');
 assert.equal(result.width,1); assert.equal(result.height,1);
 assert.equal(result.sha256,sha); assert.equal(result.bytes,Buffer.from(PNG,'base64').length);
 assert.equal(JSON.stringify(result).includes(PNG),false);
});
test('tampered digest, mismatched MIME and invalid Base64 fail closed', () => {
 assert.equal(validateImageMediaDraft({base64Content:PNG,contentType:'image/png',expectedSha256:'0'.repeat(64)}).reason,'image_digest_mismatch');
 assert.equal(validateImageMediaDraft({base64Content:PNG,contentType:'image/jpeg'}).status,'BLOCKED');
 assert.equal(validateImageMediaDraft({base64Content:'!!!',contentType:'image/png'}).status,'BLOCKED');
});
test('oversized dimensions and incomplete PNG header fail closed', () => {
 assert.equal(validateImageMediaDraft({base64Content:PNG,contentType:'image/png',maxPixels:0}).reason,'image_dimensions_invalid');
 const truncated=Buffer.from('89504e470d0a1a0a','hex').toString('base64');
 assert.equal(validateImageMediaDraft({base64Content:truncated,contentType:'image/png'}).reason,'invalid_image_header');
});
test('JPEG and WebP are blocked until independent dimension decoding is implemented', () => {
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
 assert.equal(validateImageMediaDraft({base64Content:jpeg,contentType:'image/jpeg'}).reason,'dimensions_decoder_required');
 const webp=Buffer.from('RIFF0000WEBP','ascii').toString('base64');
 assert.equal(validateImageMediaDraft({base64Content:webp,contentType:'image/webp'}).reason,'dimensions_decoder_required');
});
