'use strict';
const crypto = require('node:crypto');
const { imageDataUri, MAX_IMAGE_BYTES } = require('./powerAppsImages');

// Draft-only, pure validation. No image generation, storage, Git writes or publishing.
function validateImageMediaDraft({ base64Content, contentType, expectedSha256, maxPixels = 16000000 } = {}) {
  try {
    const { dataUri, bytes } = imageDataUri(base64Content, contentType);
    const encoded = dataUri.slice(dataUri.indexOf(',') + 1);
    const binary = Buffer.from(encoded, 'base64');
    const sha256 = crypto.createHash('sha256').update(binary).digest('hex');
    if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/i.test(expectedSha256) ||
        expectedSha256.toLowerCase() !== sha256)) return { status: 'BLOCKED', reason: 'image_digest_mismatch' };
    let width, height;
    if (contentType === 'image/png') {
      if (binary.length < 24 || binary.toString('ascii', 12, 16) !== 'IHDR')
        return { status: 'BLOCKED', reason: 'invalid_image_header' };
      width = binary.readUInt32BE(16); height = binary.readUInt32BE(20);
    } else if (contentType === 'image/gif') {
      if (binary.length < 10) return { status: 'BLOCKED', reason: 'invalid_image_header' };
      width = binary.readUInt16LE(6); height = binary.readUInt16LE(8);
    } else if (contentType === 'image/webp') {
      // RIFF signature alone does not prove decodability or safe dimensions.
      return { status: 'BLOCKED', reason: 'dimensions_decoder_required' };
    } else {
      // JPEG requires a bounded marker walk and an actual decoder; fail closed.
      return { status: 'BLOCKED', reason: 'dimensions_decoder_required' };
    }
    if (!width || !height || !Number.isSafeInteger(width * height) ||
        !Number.isSafeInteger(maxPixels) || maxPixels < 1 || width * height > maxPixels)
      return { status: 'BLOCKED', reason: 'image_dimensions_invalid' };
    return { status: 'PASS', sha256, contentType, bytes, width, height, maxBytes: MAX_IMAGE_BYTES };
  } catch {
    return { status: 'BLOCKED', reason: 'invalid_image_data' };
  }
}
module.exports = { validateImageMediaDraft };
