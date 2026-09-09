const fs = require('node:fs/promises');

const STATUSES = Object.freeze([
  '未着手', '実行中', '完了', '停止', 'エラー', '判断待ち',
  '人間承認待ち', 'ユーザー操作待ち', 'タスクなし'
]);
const NEXT_EXCLUDED_STATUSES = new Set(['人間承認待ち', 'ユーザー操作待ち', '停止', '完了']);

function resolveStatus(task) {
  if (task.retry_count >= 3) return '停止';
  if (task.approval_required === true) return '人間承認待ち';
  if (task.userActionRequired === true) return 'ユーザー操作待ち';
  return task.status || '未着手';
}

function normalizeTask(input) {
  const task = {
    ...input,
    retry_count: input.retry_count ?? 0,
    approval_required: input.approval_required === true,
    userActionRequired: input.userActionRequired === true
  };
  task.status = resolveStatus(task);
  return task;
}

class TaskStore {
  constructor(filePath) { this.filePath = filePath; }

  async read() {
    const tasks = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    return tasks.map(normalizeTask);
  }

  async write(tasks) {
    await fs.writeFile(this.filePath, `${JSON.stringify(tasks.map(normalizeTask), null, 2)}\n`, 'utf8');
  }

  async list() { return this.read(); }

  async upsert(task) {
    const tasks = await this.read();
    const index = tasks.findIndex((item) => item.id === task.id);
    const normalized = normalizeTask(task);
    if (index === -1) tasks.push(normalized);
    else tasks[index] = { ...tasks[index], ...normalized };
    await this.write(tasks);
    return normalized;
  }

  async update(id, patch) {
    const tasks = await this.read();
    const index = tasks.findIndex((item) => item.id === id);
    if (index === -1) return null;
    tasks[index] = normalizeTask({ ...tasks[index], ...patch, id });
    await this.write(tasks);
    return tasks[index];
  }

  async next() {
    const tasks = await this.read();
    return tasks.find((task) => !NEXT_EXCLUDED_STATUSES.has(task.status)) || null;
  }
}

module.exports = { NEXT_EXCLUDED_STATUSES, STATUSES, TaskStore, normalizeTask, resolveStatus };