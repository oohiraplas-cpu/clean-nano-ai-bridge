const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CnaiCheckpointStore, CnaiWorker } = require('../src/cnaiWorker');

test('persists successful stage and resumes from checkpoint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnai-'));
  try {
    const worker = new CnaiWorker(new CnaiCheckpointStore(dir));
    await worker.start('job1');
    const result = await worker.verifyAndAdvance('job1', {
      step: 'PR_COMPLETE', success: true, evidenceId: 'pr-108'
    });
    assert.equal(result.nextStep, 'CI_SUCCESS');
    const reopened = new CnaiWorker(new CnaiCheckpointStore(dir));
    assert.equal((await reopened.status('job1')).index, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('failed verification persists a blocked checkpoint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnai-'));
  try {
    const worker = new CnaiWorker(new CnaiCheckpointStore(dir));
    await worker.start('job2');
    await worker.verifyAndAdvance('job2', { step: 'PR_COMPLETE', success: false });
    assert.equal((await worker.status('job2')).status, 'BLOCKED');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('invalid checkpoint identifiers are rejected', () => {
  const store = new CnaiCheckpointStore('/tmp/cnai');
  assert.throws(() => store.file('../secret'), /invalid checkpoint/);
});
