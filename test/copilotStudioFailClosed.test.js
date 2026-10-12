'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CopilotStudioExecutionAdapter } = require('../src/executionAdapters');

test('unbound Copilot Studio operations never claim API success', async () => {
  const adapter = new CopilotStudioExecutionAdapter({ config: {} });
  for (const operation of ['createAgent','addTopic','addKnowledge','addTool','addAction','addConnector','syncMcpSchema','testAgent','publishAgent','validateAgent']) {
    const result = await adapter[operation]('agent', 'example', 'token');
    assert.equal(result.success, false, operation);
    assert.equal(result.status, 'BLOCKED', operation);
    assert.equal(result.reason, 'copilot_studio_api_not_configured', operation);
    assert.notEqual(result.published, true, operation);
  }
});
