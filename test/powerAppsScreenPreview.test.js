'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('screen preview is advertised through MCP and explicitly source-only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(source, /name: 'get_powerapps_screen_preview'/);
  assert.match(source, /if \(method === 'get_powerapps_screen_preview'\)/);
  assert.match(source, /previewType: 'source_structure', isLiveScreenshot: false/);
  assert.match(source, /readOnly: true/);
  assert.match(source, /BLOCKED: invalid Power Apps screen name/);
});
