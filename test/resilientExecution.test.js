const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../src/resilientExecution');

const nosleep = () => Promise.resolve();
const err = (o) => Object.assign(new Error(o.message || 'x'), o);

test('状態分類', () => {
  assert.equal(R.classifyFailure(err({ status: 401 })), 'AUTH_BLOCKED');
  assert.equal(R.classifyFailure(err({ status: 429 })), 'RATE_LIMITED');
  assert.equal(R.classifyFailure(err({ code: 'ECONNREFUSED' })), 'EXECUTOR_OFFLINE');
  assert.equal(R.classifyFailure(err({ code: 'ETIMEDOUT' })), 'NETWORK_ERROR');
  assert.equal(R.classifyFailure(err({ status: 503 })), 'AI_UNAVAILABLE');
  assert.equal(R.classifyFailure(new R.VerifyError('v')), 'TEST_FAILED');
  assert.equal(R.classifyFailure(new Error('?')), 'BLOCKED');
});

test('Retry後に完了し、成功済み工程は再実行されない', async () => {
  const calls = { a: 0, b: 0 };
  const job = R.createJob({ id: 'j1', steps: ['a', 'b'] });
  const handlers = {
    a: async () => { calls.a++; },
    b: async () => { if (++calls.b < 2) throw err({ code: 'ECONNRESET' }); },
  };
  await R.runJob(job, handlers, { sleep: nosleep });
  assert.equal(job.status, 'COMPLETED');
  assert.deepEqual(calls, { a: 1, b: 2 });
  assert.equal(job.checkpoints.length, 2);
});

test('Failover: executor offline時に次のtargetへ切替', async () => {
  const used = [];
  const job = R.createJob({ id: 'j2', steps: ['a'], targets: ['win1', 'win2'] });
  await R.runJob(job, { a: async ({ target }) => { used.push(target); if (target === 'win1') throw err({ code: 'ECONNREFUSED' }); } }, { sleep: nosleep });
  assert.deepEqual(used, ['win1', 'win2']);
  assert.equal(job.status, 'COMPLETED');
});

test('AUTH_BLOCKEDは再試行せず停止、後で直近Checkpointから再開(Auto Resume)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rj-')), 'job.json');
  const calls = { a: 0, b: 0 };
  let authOk = false;
  const handlers = {
    a: async () => { calls.a++; },
    b: async () => { calls.b++; if (!authOk) throw err({ status: 401 }); },
  };
  const job = R.createJob({ id: 'j3', steps: ['a', 'b'] });
  await R.runJob(job, handlers, { sleep: nosleep, persist: (j) => R.saveJob(file, j) });
  assert.equal(job.status, 'AUTH_BLOCKED');
  assert.equal(calls.b, 1);
  // プロセス再起動相当: ファイルからロードして再開
  const reloaded = R.loadJob(file);
  assert.deepEqual(reloaded.completedSteps, ['a']);
  authOk = true;
  await R.runJob(reloaded, handlers, { sleep: nosleep, persist: (j) => R.saveJob(file, j) });
  assert.equal(reloaded.status, 'COMPLETED');
  assert.deepEqual(calls, { a: 1, b: 2 });
});

test('Verify失敗はTEST_FAILED→上限でBLOCKED、成功扱いにしない', async () => {
  const job = R.createJob({ id: 'j4', steps: ['a'], maxAttempts: 2 });
  await R.runJob(job, { a: async () => 1 }, { verifiers: { a: async () => false }, sleep: nosleep });
  assert.equal(job.status, 'BLOCKED');
  assert.deepEqual(job.completedSteps, []);
  assert.ok(job.history.some((h) => h.state === 'TEST_FAILED'));
});

test('Secretは履歴・永続ファイルに残らない', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rj-')), 'job.json');
  const secret = `ghp_${'z'.repeat(30)}`;
  const job = R.createJob({ id: 'j5', steps: ['a'], maxAttempts: 1 });
  await R.runJob(job, { a: async () => { throw err({ code: 'ECONNRESET', message: `token ${secret}` }); } }, { sleep: nosleep, persist: (j) => R.saveJob(file, j) });
  assert.ok(!fs.readFileSync(file, 'utf8').includes(secret));
});
