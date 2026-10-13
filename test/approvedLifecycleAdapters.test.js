'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerAppsExecutionAdapter, SharePointExecutionAdapter, PowerAutomateExecutionAdapter } = require('../src/executionAdapters');
const cases = [
  [PowerAppsExecutionAdapter, ['createScreen','addControl','addPowerFx','addDataSource','addFlow','saveApp','publishApp','validateChanges']],
  [SharePointExecutionAdapter, ['createList','registerData','updateData','validateSchema']],
  [PowerAutomateExecutionAdapter, ['createFlow','addTrigger','addAction','addCondition','addErrorHandling','getRunHistory','getRunResult']]
];
for (const [Adapter, methods] of cases) {
  test(`${Adapter.name}: unsupported writes and verification never claim success or call API`, async () => {
    let calls = 0;
    const spy = new Proxy({}, { get() { return async () => { calls++; return { success: true }; }; } });
    const adapter = new Adapter({ powerAppsStore: spy, powerAppsGitStore: spy, sharePointReader: spy, powerAutomateRunner: spy });
    for (const method of methods) {
      const result = await adapter[method]('app', 'screen', 'control', 'approval-token');
      assert.equal(result.success, false, method);
      assert.equal(result.status, 'blocked', method);
    }
    assert.equal(calls, 0);
  });
}
test('Power Automate missing runner is blocked and configured runner result is preserved', async () => {
  assert.equal((await new PowerAutomateExecutionAdapter({}).runFlow('flow', {})).success, false);
  let calls = 0;
  const result = { status: 'ok', httpStatus: 202 };
  const adapter = new PowerAutomateExecutionAdapter({ powerAutomateRunner: { runFlow: async () => { calls++; return result; } } });
  assert.equal(await adapter.runFlow('flow', {}), result);
  assert.equal(calls, 1);
});
