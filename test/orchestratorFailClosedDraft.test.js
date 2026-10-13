'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/platformOrchestrator.js'), 'utf8');
test('orchestrator fails closed before unverified production publish', () => {
  assert.match(source, /approved_single_use_gate_not_wired/);
  assert.match(source, /return this\._returnBlocked\('独立承認ゲート未接続'/);
});
test('published state is not logged before the independent gate', () => {
  const start = source.indexOf('if (publishApproval) {', source.indexOf('// Step 18-19'));
  const blocked = source.indexOf('approved_single_use_gate_not_wired', start);
  const published = source.indexOf("this._logExecution('PUBLISHED'", start);
  assert.ok(start >= 0 && blocked > start && (published < 0 || blocked < published));
});
