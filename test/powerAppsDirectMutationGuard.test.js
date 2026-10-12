'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Static regression: update passes a deny-by-default gate. Legacy writer is
// unreachable; save/publish still share their unconditional fail-closed guard.
test('direct Power Apps mutation routes remain blocked before legacy dispatch', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const editGate = source.indexOf("if (method === 'update_powerapps_app') {");
  assert.ok(editGate >= 0, 'missing update authorization branch');
  const saveGuard = source.indexOf("if (['save_powerapps_app', 'publish_powerapps_app'].includes(method))", editGate);
  assert.ok(saveGuard > editGate, 'missing save/publish mutation guard');
  const editGuard = source.slice(editGate, saveGuard);
  assert.match(editGuard, /await powerAppsMutationGate\(\{ operation: 'update' \}\)/);
  assert.match(editGuard, /throw requestError\('BLOCKED: legacy Power Apps update route is disabled'\)/);
  assert.match(editGuard, /throw requestError\('BLOCKED: direct Power Apps mutation approval gate is not configured'\)/);
  assert.match(source.slice(saveGuard, saveGuard + 240), /throw requestError\('BLOCKED: direct Power Apps mutation approval gate is not configured'\)/);
  for (const operation of ['update_powerapps_app', 'save_powerapps_app', 'publish_powerapps_app']) {
    const route = source.indexOf(`if (method === '${operation}')`, saveGuard + 1);
    assert.ok(route > saveGuard, `${operation} legacy writer must follow both guards`);
  }
});
