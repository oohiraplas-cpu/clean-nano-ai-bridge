const test = require('node:test');
const assert = require('node:assert/strict');
const adapters = require('../src/executionAdapters');
const blocked = {
  PowerAppsExecutionAdapter: ['saveApp', 'publishApp', 'validateChanges'],
  SharePointExecutionAdapter: ['addColumn', 'updateColumnSettings', 'createList', 'registerData', 'updateData'],
  PowerAutomateExecutionAdapter: ['createFlow', 'addTrigger', 'addAction', 'addCondition', 'addErrorHandling', 'enableFlow', 'disableFlow', 'validateFlow'],
  CopilotStudioExecutionAdapter: ['createAgent', 'addTopic', 'addKnowledge', 'addTool', 'addAction', 'addConnector', 'syncMcpSchema', 'testAgent', 'publishAgent', 'validateAgent']
};
for (const [name, methods] of Object.entries(blocked)) {
  for (const method of methods) test(`${name}.${method} cannot fabricate success or accept a caller approval token`, async () => {
    const adapter = new adapters[name]({ config: {} });
    await assert.rejects(adapter[method]('target', 'caller-supplied-token', {}), error => {
      assert.equal(error.status, 503);
      assert.equal(error.payload.status, 'not_configured');
      assert.ok(error.payload.missingConfiguration.includes('scopedApprovalLedger'));
      return true;
    });
  });
}

const { PowerPlatformRequestHandler } = require('../src/powerPlatformRequestHandler');
test('integrated execution refuses self-asserted approval before any orchestrator call', async () => {
  const handler = new PowerPlatformRequestHandler({ config: {} });
  let called = false;
  handler.orchestrator.executePowerPlatformRequest = async () => { called = true; throw new Error('must not call'); };
  const result = await handler.executePowerPlatformRequest({ request: 'Publish the app',
    targetId: 'app', environmentId: 'production', publishApproval: true,
    approvedByHuman: true, approvalToken: 'caller-token' });
  assert.equal(result.conclusion, 'BLOCKED');
  assert.equal(result.externalApiCalled, false);
  assert.equal(called, false);
  assert.ok(result.errors.includes('scoped_approval_executor_not_configured'));
  assert.ok(handler.getAuditTrail(result.requestId).entries.length > 0);
});
