'use strict';

// 依存関係つきタスクの実行管理（DAG）。固定Waveを待たず、依存が満たされたタスクから開始する。
// - 依存が PASS（completed）したタスクだけを後続の対象にする。
// - 同じファイルを触るタスクは同時に走らせない（書込み競合の防止）。
// - 失敗したタスクと、その依存先だけを isolated にし、他の正常タスクは継続する。
// - BLOCKED（人間操作待ち）は失敗ではなく、依存先を待機させるだけにする。
// - 重大な安全条件の失敗は、同じ system のタスクだけを停止する（全体は止めない）。
// - 状態は機械可読な JSON で出力する。

const STATES = Object.freeze(['pending', 'running', 'completed', 'failed', 'blocked', 'isolated', 'stopped']);

function createTaskGraph(tasks, { maxParallel = 3 } = {}) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error('maxParallel must be a positive integer');
  const byId = new Map();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || task.id.length === 0) throw new Error('task id is required');
    if (byId.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    byId.set(task.id, {
      id: task.id,
      deps: Array.isArray(task.deps) ? [...task.deps] : [],
      files: Array.isArray(task.files) ? [...task.files] : [],
      system: typeof task.system === 'string' ? task.system : 'default',
      state: 'pending',
      reasonCode: null,
      result: null
    });
  }
  for (const node of byId.values()) {
    for (const dep of node.deps) if (!byId.has(dep)) throw new Error(`unknown dependency: ${dep} (from ${node.id})`);
  }
  assertAcyclic(byId);

  const depsDone = (node) => node.deps.every((dep) => byId.get(dep).state === 'completed');
  const runningFiles = () => new Set([...byId.values()].filter((n) => n.state === 'running').flatMap((n) => n.files));
  const hasFileConflict = (node) => node.files.some((f) => runningFiles().has(f));

  function readyTasks() {
    const out = [];
    for (const node of byId.values()) {
      if (node.state === 'pending' && depsDone(node) && !hasFileConflict(node)) out.push(node.id);
    }
    return out;
  }

  // 空き枠（maxParallel）の範囲で、準備ができたタスクを開始させる。
  function startReady() {
    const running = [...byId.values()].filter((n) => n.state === 'running').length;
    const slots = Math.max(0, maxParallel - running);
    const started = [];
    for (const id of readyTasks()) {
      if (started.length >= slots) break;
      const node = byId.get(id);
      if (hasFileConflict(node)) continue; // 同じ回の中でも競合させない
      node.state = 'running';
      started.push(id);
    }
    return started;
  }

  function get(id) {
    const node = byId.get(id);
    if (!node) throw new Error(`unknown task: ${id}`);
    return node;
  }

  function complete(id, result = null) {
    const node = get(id);
    if (node.state !== 'running') throw new Error(`task ${id} is not running`);
    node.state = 'completed';
    node.result = result;
    return readyTasks();
  }

  // 失敗は当該タスクと依存先のみを隔離する。
  function fail(id, reasonCode) {
    const node = get(id);
    if (node.state !== 'running') throw new Error(`task ${id} is not running`);
    node.state = 'failed';
    node.reasonCode = reasonCode;
    const queue = [id];
    while (queue.length) {
      const current = queue.shift();
      for (const other of byId.values()) {
        if (other.deps.includes(current) && other.state === 'pending') {
          other.state = 'isolated';
          other.reasonCode = 'DEPENDENCY_FAILED';
          queue.push(other.id);
        }
      }
    }
    return { failed: id, isolated: [...byId.values()].filter((n) => n.state === 'isolated').map((n) => n.id) };
  }

  // 人間操作待ち。失敗とはせず、依存先は待機のまま（pending）にする。
  function block(id, reasonCode, humanAction) {
    const node = get(id);
    if (node.state !== 'running') throw new Error(`task ${id} is not running`);
    node.state = 'blocked';
    node.reasonCode = reasonCode;
    node.humanAction = humanAction || null;
    return { blocked: id };
  }

  function unblock(id) {
    const node = get(id);
    if (node.state !== 'blocked') throw new Error(`task ${id} is not blocked`);
    node.state = 'pending';
    node.reasonCode = null;
    node.humanAction = null;
  }

  // 重大な安全条件の失敗: 同じ system の未完了タスクだけを停止する。
  function stopSystem(system, reasonCode) {
    const stopped = [];
    for (const node of byId.values()) {
      if (node.system === system && (node.state === 'pending' || node.state === 'running')) {
        node.state = 'stopped';
        node.reasonCode = reasonCode;
        stopped.push(node.id);
      }
    }
    return stopped;
  }

  function summary() {
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const node of byId.values()) counts[node.state] += 1;
    return counts;
  }

  function toJSON() {
    return {
      schema: 'clean-nano-task-graph/1',
      maxParallel,
      counts: summary(),
      tasks: [...byId.values()].map((n) => ({
        id: n.id, state: n.state, deps: n.deps, files: n.files, system: n.system, reasonCode: n.reasonCode, humanAction: n.humanAction || null
      }))
    };
  }

  return { readyTasks, startReady, complete, fail, block, unblock, stopSystem, get, summary, toJSON, STATES };
}

function assertAcyclic(byId) {
  const visiting = new Set();
  const done = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`dependency cycle at ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id).deps) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

module.exports = { createTaskGraph, STATES };
