'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDependencies } = require('../src/bridgeCapabilities');

function connected() {
  return {
    powerAppsStore: { getAppState: async () => ({ id: 'app' }) },
    sharePointReader: { healthCheck: async () => ({ ok: true }) },
    powerAutomateRunner: { healthCheck: async () => ({ ok: true }) },
    powerAppsGitStore: { healthCheck: async () => ({ ok: true, branch: 'main' }) }
  };
}

test('transient read retries once and successful health never enables production', async () => {
  const options = connected(); let calls = 0;
  options.powerAppsStore.getAppState = async () => {
    if (++calls === 1) throw Object.assign(new Error('private provider body'), { status: 503 });
    return { id: 'app' };
  };
  const result = await checkDependencies(options);
  assert.equal(calls, 2);
  assert.equal(result.verified, true);
  assert.equal(result.data.recovery.connectivityStatus, 'PASS');
  assert.equal(result.data.recovery.recoveryStatus, 'BLOCKED');
  assert.equal(result.data.recovery.productionReady, false);
  assert.equal(result.data.recovery.checks[0].attempts, 2);
  assert.ok(result.data.recovery.unverified.includes('azure_running_sha'));
});

test('authentication failure never retries, mutates, or leaks provider text', async () => {
  const options = connected(); let calls = 0;
  options.powerAppsStore.getAppState = async () => {
    calls++; throw Object.assign(new Error('secret-token'), { status: 403, code: 'ECONNRESET' });
  };
  options.powerAppsStore.save = options.powerAppsStore.publish = () => assert.fail('mutation');
  const result = await checkDependencies(options);
  assert.equal(calls, 1);
  assert.equal(result.verified, false);
  assert.equal(result.data.recovery.checks[0].nextAction, 'reauthenticate_then_recheck');
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('persistent transient failures stop after two reads', async () => {
  const options = connected(); let calls = 0;
  options.sharePointReader.healthCheck = async () => {
    calls++; throw Object.assign(new Error('offline'), { code: 'ETIMEDOUT' });
  };
  const result = await checkDependencies(options);
  assert.equal(calls, 2);
  assert.equal(result.verified, false);
  assert.equal(result.data.recovery.checks[1].attempts, 2);
});

test('negative health response cannot be reported as all dependencies healthy', async () => {
  for (const key of ['sharePointReader', 'powerAutomateRunner', 'powerAppsGitStore']) {
    const options = connected(); options[key].healthCheck = async () => ({ ok: false });
    const result = await checkDependencies(options);
    assert.equal(result.verified, false, key);
    assert.notEqual(result.status, 'ok', key);
    assert.equal(result.data.recovery.connectivityStatus, 'BLOCKED');
  }
});

test('missing configuration and empty app identity remain blocked', async () => {
  const missing = await checkDependencies();
  assert.equal(missing.data.recovery.checks.length, 4);
  assert.ok(missing.data.recovery.checks.every(c => c.status === 'BLOCKED' && c.attempts === 0));
  const options = connected(); options.powerAppsStore.getAppState = async () => ({});
  assert.equal((await checkDependencies(options)).verified, false);
});

test('unknown failures and rate limits are not immediately replayed', async () => {
  for (const status of [400, 401, 429, 500]) {
    const options = connected(); let calls = 0;
    options.powerAppsGitStore.healthCheck = async () => {
      calls++; throw Object.assign(new Error('private'), { status });
    };
    assert.equal((await checkDependencies(options)).verified, false);
    assert.equal(calls, 1, String(status));
  }
});

test('optional unconfigured flows remain explicitly skipped, never recovered', async () => {
  const options = connected();
  options.powerAutomateRunner.healthCheck = async () => ({ status: 'not_configured' });
  const result = await checkDependencies(options);
  assert.equal(result.status, 'ok');
  assert.equal(result.data.recovery.checks[2].status, 'SKIPPED');
  assert.equal(result.data.recovery.recoveryStatus, 'BLOCKED');
});
