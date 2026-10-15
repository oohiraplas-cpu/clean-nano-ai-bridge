const assert = require('node:assert/strict');
const test = require('node:test');
const { MCP_PUBLIC_TOOLS } = require('../src/server');
const { STATE_CONTEXT_SCHEMA } = require('../src/stateContext');

test('ensure_sharepoint_columns exposes stateContext so fail-closed writes can receive it', () => {
  const tool = MCP_PUBLIC_TOOLS.find((entry) => entry.name === 'ensure_sharepoint_columns');
  assert.ok(tool, 'ensure_sharepoint_columns must be publicly exposed');
  assert.deepEqual(tool.inputSchema.properties.stateContext, STATE_CONTEXT_SCHEMA);
  assert.ok(tool.inputSchema.required.includes('stateContext'));
  assert.ok(tool.inputSchema.properties.stateSessionId);
  assert.equal(tool.inputSchema.additionalProperties, false);
});
