const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

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
    let content;
    try { content = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const tasks = JSON.parse(content);
    if (!Array.isArray(tasks)) throw new Error('タスク保存ファイルの形式が不正です');
    return tasks.map(normalizeTask);
  }

  async write(tasks) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = this.filePath + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(tasks.map(normalizeTask), null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
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