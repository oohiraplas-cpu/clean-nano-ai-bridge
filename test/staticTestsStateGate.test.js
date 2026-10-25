'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FAIL_CLOSED_TOOLS, validateStateContext } = require('../src/stateManager');
const { runStaticTests } = require('../src/powerAppsStaticTests');

test('pure static tests do not require write StateContext', () => {
  assert.equal(FAIL_CLOSED_TOOLS.includes('run_powerapps_tests'), false);
  assert.equal(validateStateContext('run_powerapps_tests', {}, null).isValid, true);
  const result = runStaticTests({ files: [{ relativePath: 'S1_Home.pa.yaml', content: 'Screens:\\n  S1_Home:\\n    Properties:\\n      Fill: =RGBA(0,0,0,1)\\n'.replace(/\\n/g, '\n') }] });
  assert.ok(result);
});

test('write, save, publish and privileged operations remain fail-closed', () => {
  for (const name of ['update_powerapps_app', 'save_powerapps_app', 'publish_powerapps_app', 'update_permissions', 'deploy_to_test', 'ensure_sharepoint_columns']) {
    assert.equal(FAIL_CLOSED_TOOLS.includes(name), true, name);
    assert.equal(validateStateContext(name, {}, null).isValid, false, name);
  }
});
