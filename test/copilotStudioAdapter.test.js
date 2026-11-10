'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCopilotStudioAdapter, ENVIRONMENT_ID, AGENT_ID } = require('../src/oz/copilotStudioAdapter');

test('Copilot Studio adapter denies unauthenticated, mismatched and unavailable provider', async () => {
  const adapter = createCopilotStudioAdapter();
  assert.equal((await adapter.invoke('inspect')).reasonCode, 'AUTH_REQUIRED');
  assert.equal((await adapter.invoke('inspect', { environmentId: 'other' }, { authenticated: true })).reasonCode, 'TARGET_MISMATCH');
  assert.equal((await adapter.invoke('inspect', {}, { authenticated: true })).reasonCode, 'MICROSOFT_PROVIDER_NOT_CONNECTED');
  assert.equal((await adapter.invoke('delete', {}, { authenticated: true })).reasonCode, 'UNSUPPORTED_ACTION');
});

test('Copilot Studio adapter READ only with authenticated injected provider', async () => {
  let called = 0;
  const adapter = createCopilotStudioAdapter({ inspect: async ({ environmentId, agentId }) => {
    called++;
    assert.equal(environmentId, ENVIRONMENT_ID);
    assert.equal(agentId, AGENT_ID);
    return { status: 'PASS', agentId };
  } });
  assert.equal((await adapter.invoke('inspect', {}, { authenticated: true })).status, 'PASS');
  assert.equal(called, 1);
});

test('Copilot Studio adapter blocks production draft writes until every gate is verified', async () => {
  let writes = 0;
  const adapter = createCopilotStudioAdapter({ applyDraft: async () => { writes++; return { status: 'PASS' }; } });
  const base = { authenticated: true };
  const stages = [
    [base, 'PERMISSION_NOT_VERIFIED'],
    [{ ...base, permissionVerified: true }, 'LICENSE_NOT_VERIFIED'],
    [{ ...base, permissionVerified: true, licenseVerified: true }, 'SNAPSHOT_REQUIRED'],
    [{ ...base, permissionVerified: true, licenseVerified: true, snapshotVerified: true }, 'DRY_RUN_REQUIRED'],
    [{ ...base, permissionVerified: true, licenseVerified: true, snapshotVerified: true, dryRunVerified: true }, 'PRODUCTION_APPROVAL_REQUIRED']
  ];
  for (const [context, reason] of stages)
    assert.equal((await adapter.invoke('applyDraft', {}, context)).reasonCode, reason);
  assert.equal(writes, 0);
});

test('Copilot Studio adapter masks provider exceptions and refuses invalid responses', async () => {
  const failing = createCopilotStudioAdapter({ inspect: async () => { throw Error('secret'); } });
  assert.deepEqual(await failing.invoke('inspect', {}, { authenticated: true }),
    { status: 'BLOCKED', reasonCode: 'PROVIDER_ERROR', executed: false });
  const invalid = createCopilotStudioAdapter({ inspect: async () => null });
  assert.equal((await invalid.invoke('inspect', {}, { authenticated: true })).reasonCode, 'INVALID_PROVIDER_RESPONSE');
});
