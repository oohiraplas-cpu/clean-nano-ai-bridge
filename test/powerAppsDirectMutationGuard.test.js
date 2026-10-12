'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Static regression: keep all direct Power Apps mutation routes behind a
// fail-closed guard until the shared trusted approval gate is wired and tested.
test('direct Power Apps mutation routes are blocked before dispatch', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const marker = "if (['update_powerapps_app', 'save_powerapps_app', 'publish_powerapps_app'].includes(method))";
  const guard = source.indexOf(marker);
  assert.ok(guard >= 0, 'missing direct mutation guard');
  assert.match(source.slice(guard, guard + 250), /throw requestError\('BLOCKED: direct Power Apps mutation approval gate is not configured'\)/);
  for (const operation of ['update_powerapps_app', 'save_powerapps_app', 'publish_powerapps_app']) {
    const route = source.indexOf(`if (method === '${operation}')`, guard + marker.length);
    assert.ok(route > guard, `${operation} must follow the fail-closed guard`);
  }
});
