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
  assert.match(source, /structure: screenStructurePreview\(source.content, screenName\)/);
  assert.match(source, /BLOCKED: invalid Power Apps screen name/);
});

const { screenStructurePreview } = require('../src/powerAppsScreenPreview');
test('screen YAML is converted to a bounded, read-only hierarchy', () => {
  const source = [
    'Screens:',
    '  S1_Home:',
    '    Properties:',
    '      Fill: =RGBA(8, 8, 9, 1)',
    '    Children:',
    '      - S1_Title:',
    '          Control: Label@2.5.1',
    '          Properties:',
    '            Text: ="CLEAN NANO"',
    '            X: =16',
    '            Y: =12',
  ].join('\\n');
  const result = screenStructurePreview(source, 'S1_Home');
  assert.equal(result.controlCount, 1);
  assert.equal(result.controls[0].name, 'S1_Title');
  assert.equal(result.controls[0].properties.Text, '="CLEAN NANO"');
  assert.equal(result.controls[0].properties.X, '=16');
});
test('invalid or missing screens fail closed', () => {
  assert.throws(() => screenStructurePreview('Screens: {}', 'S1_Home'), /BLOCKED/);
  assert.throws(() => screenStructurePreview('Screens: [', 'S1_Home'));
});
