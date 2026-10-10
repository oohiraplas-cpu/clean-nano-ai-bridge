const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../src/taskStore');

async function withTasks(tasks, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnai-task-'));
  try {
    const file = path.join(dir, 'tasks.json');
    await fs.writeFile(file, JSON.stringify(tasks));
    await fn(new TaskStore(file));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('skips demo and selects high-priority work', async () => {
  await withTasks([
    { id: 'demo-001', source: 'local-demo', status: '未着手' },
    { id: 'normal', priority: 'normal', status: '未着手' },
    { id: 'high', priority: 'high', status: '未着手' }
  ], async store => assert.equal((await store.next()).id, 'high'));
});

test('resumes running task before new high priority task', async () => {
  await withTasks([
    { id: 'high', priority: 'high', status: '未着手' },
    { id: 'running', priority: 'normal', status: '実行中' }
  ], async store => assert.equal((await store.next()).id, 'running'));
});

test('does not run approval-required, stopped or completed work', async () => {
  await withTasks([
    { id: 'approval', approval_required: true, priority: 'critical' },
    { id: 'stopped', status: '停止', priority: 'high' },
    { id: 'done', status: '完了' }
  ], async store => assert.equal(await store.next(), null));
});

test('preserves FIFO among tasks of equal priority', async () => {
  await withTasks([
    { id: 'first', priority: 'high', status: '未着手' },
    { id: 'second', priority: 'high', status: '未着手' }
  ], async store => assert.equal((await store.next()).id, 'first'));
});
