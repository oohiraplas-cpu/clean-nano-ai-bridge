const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PowerAppsStore } = require('../src/powerAppsStore');

test('operation index retains 500 latest entries and hydrates once after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-op-cache-'));
  try {
    const logPath = path.join(dir, 'operations.jsonl');
    const store = new PowerAppsStore({ appId: 'target', logPath });
    await Promise.all(Array.from({ length: 510 }, (_, i) =>
      store._recordOperation('op-' + i, 'test', 'env', 'target', { status: 'success', result: { i } })
    ));
    assert.equal((await store.getOperationLog(1000)).count, 500);
    assert.equal((await store.getOperationResult('op-0')).status, 'not_found');
    assert.equal((await store.getOperationResult('op-509')).result.i, 509);
    const restarted = new PowerAppsStore({ appId: 'target', logPath });
    assert.equal((await restarted.getOperationResult('op-509')).status, 'ok');
    assert.equal((await restarted.getOperationLog(1000)).count, 500);
    await fs.unlink(logPath);
    assert.equal((await restarted.getOperationResult('op-509')).status, 'ok');
    assert.equal((await restarted.getOperationLog(3)).count, 3);
    assert.equal((await restarted.getOperationLog(0)).count, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
