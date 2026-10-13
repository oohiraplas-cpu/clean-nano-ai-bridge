'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/platformOrchestrator.js'), 'utf8');
const execute = source.slice(source.indexOf('async executePowerPlatformRequest('), source.indexOf('async _publishChanges('));
test('unverified approval blocks BEFORE deployment', () => {
  const guard = execute.indexOf("['approved_single_use_gate_not_wired'], requestIdLocal);");
  const deploy = execute.indexOf('const deployment = await this._deployChanges(');
  assert.ok(guard >= 0 && deploy > guard, 'guard must precede deployment');
});
test('unverified approval blocks BEFORE publish', () => {
  const guard = execute.indexOf('approved_single_use_gate_not_wired');
  const published = execute.indexOf("this._logExecution('PUBLISHED'");
  assert.ok(guard >= 0 && published > guard);
});
test('PowerAppsStore publish response uses status, not success', () => {
  const store = fs.readFileSync(path.join(__dirname, '../src/powerAppsStore.js'), 'utf8');
  assert.match(store, /return \{ status: 'ok', operationId, appId: this\.appId/);
});
