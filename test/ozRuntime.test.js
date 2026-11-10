'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOzRuntime } = require('../src/oz/runtime');
test('OZ denies unauthenticated caller and forged authority payload', async () => {
  const runtime = createOzRuntime({}, { operations: { callTool: async () => { throw Error('should not run'); } } });
  assert.equal((await runtime.dispatch({ entry: 'OZ_QUERY', operation: 'health_check', payload: { authenticated: true } })).reasonCode, 'AUTH_REQUIRED');
});
test('OZ query refuses writes and execute refuses unverified writes', async () => {
  const runtime = createOzRuntime({}, { operations: { callTool: async () => { throw Error('should not run'); } } });
  const auth = { transportAuthenticated: true, writeAuthorized: true, humanApproved: true };
  assert.equal((await runtime.dispatch({ entry: 'OZ_QUERY', operation: 'create_task' }, auth)).reasonCode, 'QUERY_READ_ONLY');
  assert.equal((await runtime.dispatch({ entry: 'OZ_EXECUTE', operation: 'create_task' }, auth)).reasonCode, 'WRITE_LANE_NOT_AUTHORIZED');
});
test('OZ control rejects unconfigured actions', async () => {
  const runtime = createOzRuntime({}, { operations: { callTool: async () => ({ status: 'PASS' }) } });
  assert.equal((await runtime.dispatch({ entry: 'OZ_CONTROL', operation: 'delete_all' }, { transportAuthenticated: true })).reasonCode, 'CONTROL_NOT_CONFIGURED');
});
test('OZ read routes to existing operations runtime', async () => {
  let called = 0;
  const runtime = createOzRuntime({}, { operations: { callTool: async (name) => { called++; return { status: 'PASS', name }; } } });
  const result = await runtime.dispatch({ entry: 'OZ_QUERY', operation: 'health_check' }, { transportAuthenticated: true });
  assert.equal(result.name, 'health_check');
  assert.equal(called, 1);
});
