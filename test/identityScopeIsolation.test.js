const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('source binding uses the authenticated request scope', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(code, /config = \{\}, stateRegistry, requestScope\) \{/);
  assert.match(code, /bridgeServices, config, stateRegistry, scope\);/);
  assert.equal((code.match(/const scope = requestScope \|\| 'POWERAPPS_SOURCE_RESOLUTION';/g) || []).length, 2);
});
test('S7 worker switching is hidden and disabled', () => {
  const code = fs.readFileSync(path.join(__dirname, '../powerapps/CN_AI依頼台帳/Source/S7_Settings.pa.yaml'), 'utf8');
  const control = code.split('      - S7_GoMembers:')[1]?.split('      - S7_Reload:')[0];
  assert.ok(control);
  assert.match(control, /Visible: =false/);
  assert.match(control, /DisplayMode: =DisplayMode.Disabled/);
  assert.doesNotMatch(control, /Navigate\(S6_Members/);
});
