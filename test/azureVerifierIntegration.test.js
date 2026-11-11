const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Azure verifier uses read-only metadata and fail-closed readiness', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-production-bridge.js'), 'utf8');
  assert.match(source, /assessAzureReadiness\(observed\)/);
  assert.match(source, /'webapp', 'identity', 'show'/);
  assert.match(source, /'role', 'assignment', 'list'/);
  assert.match(source, /resourceIdMatched:/);
  assert.match(source, /pacProfileVerified: false/);
  assert.match(source, /sourceMapVerified: false/);
  assert.match(source, /deploymentShaMatched: false/);
  assert.doesNotMatch(source, /'role', 'assignment', 'create'/);
  assert.doesNotMatch(source, /'webapp', 'identity', 'assign'/);
});
