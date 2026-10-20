const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('source observation binding uses authenticated request scope, not a fixed scope', () => {
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(server, /config = \{\}, stateRegistry, requestScope\) \{/);
  assert.match(server, /bridgeServices, config, stateRegistry, scope\);/);
  assert.equal((server.match(/const scope = requestScope \|\| 'POWERAPPS_SOURCE_RESOLUTION';/g) || []).length, 2);
  assert.doesNotMatch(server, /const scope = 'POWERAPPS_SOURCE_RESOLUTION';/);
});
