'use strict';
// 残作業DAG（Lane 4）: 定義・証跡ベースの状態判定・クリティカルパス・完了率・実行器・チェックポイント拡張。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { REQUIRED_TASK_IDS, REMAINING_TASKS, evaluateTasks, computeCriticalPath, completionPercent, blockedItemsOf } = require('../src/orchestration/remainingWork');
const { runDag, REASON_EXECUTOR_ERROR } = require('../src/orchestration/executor');
const { buildCheckpoint, validateCheckpoint, saveCheckpoint, restoreCheckpoint } = require('../src/orchestration/checkpoint');
const { buildStatus } = require('../scripts/orchestrate');

const REPO_ROOT = path.resolve(__dirname, '..');

function tmpRepo(files = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-'));
  for (const f of files) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '// evidence\n');
  }
  return dir;
}

// ---------- 定義 ----------

test('every required task from the work order is defined with the required fields', () => {
  const ids = new Set(REMAINING_TASKS.map((t) => t.id));
  for (const id of REQUIRED_TASK_IDS) assert.ok(ids.has(id), `missing required task ${id}`);
  assert.equal(REQUIRED_TASK_IDS.length, 13);
  const evaluated = evaluateTasks(REPO_ROOT);
  for (const t of evaluated) {
    for (const field of ['id', 'goal', 'dependencies', 'requiredCapabilities', 'estimatedEffort', 'criticalPathWeight', 'status',
      'assignedLane', 'affectedFiles', 'selectiveTests', 'fullRegressionRequired', 'rollbackAvailable', 'humanGate', 'additionalCost']) {
      assert.ok(t[field] !== undefined, `${t.id} missing ${field}`);
    }
  }
});

test('the dependency graph is valid and acyclic', () => {
  const ids = new Set(REMAINING_TASKS.map((t) => t.id));
  for (const t of REMAINING_TASKS) for (const d of t.deps) assert.ok(ids.has(d), `${t.id} depends on unknown ${d}`);
  // taskGraph が循環を拒否するので、構築できれば非循環。
  const { createTaskGraph } = require('../src/orchestration/taskGraph');
  assert.doesNotThrow(() => createTaskGraph(REMAINING_TASKS.map((t) => ({ id: t.id, deps: t.deps, files: t.affectedFiles, system: t.system }))));
});

// ---------- 状態判定（証跡ファイルの存在） ----------

test('status is COMPLETE only when all evidence files exist, and READY when dependencies are complete', () => {
  const repo = tmpRepo(['src/orchestration/remainingWork.js', 'src/orchestration/executor.js', 'scripts/orchestrate.js']);
  const byId = Object.fromEntries(evaluateTasks(repo).map((t) => [t.id, t]));
  assert.equal(byId.DAG_EXECUTOR.status, 'COMPLETE');
  assert.equal(byId.ENTRA_READ.status, 'READY'); // DAG_EXECUTOR が完了したため着手可能
  assert.equal(byId.ENTRA_WRITE.status, 'PENDING'); // ENTRA_READ 未完了
  assert.equal(byId.FILES_ZIP_FACADE.status, 'READY'); // 依存なし
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a task without evidence is never reported COMPLETE, even when its dependency is done', () => {
  const repo = tmpRepo([]);
  const evaluated = evaluateTasks(repo);
  assert.ok(evaluated.every((t) => t.status !== 'COMPLETE'));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('live status is tracked separately and no task is marked live-verified without evidence', () => {
  const evaluated = evaluateTasks(REPO_ROOT);
  assert.equal(evaluated.filter((t) => t.liveStatus === 'VERIFIED').length, 0);
  assert.equal(evaluated.find((t) => t.id === 'ENTRA_READ').liveStatus, 'BLOCKED');
});

test('the repository status is consistent: no COMPLETE task depends on an incomplete one', () => {
  const evaluated = evaluateTasks(REPO_ROOT);
  const byId = Object.fromEntries(evaluated.map((t) => [t.id, t]));
  for (const t of evaluated) {
    if (t.status !== 'COMPLETE') continue;
    for (const d of t.dependencies) {
      assert.equal(byId[d].status, 'COMPLETE', `${t.id} is COMPLETE but ${d} is ${byId[d].status}`);
    }
  }
});

// ---------- クリティカルパス・完了率 ----------

test('critical path is the heaviest chain over open tasks only', () => {
  const evaluated = [
    { id: 'A', status: 'COMPLETE', dependencies: [], criticalPathWeight: 10 },
    { id: 'B', status: 'READY', dependencies: ['A'], criticalPathWeight: 2 },
    { id: 'C', status: 'PENDING', dependencies: ['B'], criticalPathWeight: 3 },
    { id: 'D', status: 'PENDING', dependencies: [], criticalPathWeight: 4 }
  ];
  assert.deepEqual(computeCriticalPath(evaluated), ['B', 'C']);
});

test('completion percent separates code completion from live verification', () => {
  const evaluated = [
    { status: 'COMPLETE', liveStatus: 'BLOCKED', criticalPathWeight: 3 },
    { status: 'READY', liveStatus: 'NOT_VERIFIED', criticalPathWeight: 1 }
  ];
  assert.deepEqual(completionPercent(evaluated), { code: 75, live: 0 });
});

test('blocked items carry the human gate reason so they can be deduplicated', () => {
  const evaluated = [
    { id: 'X', status: 'COMPLETE', liveStatus: 'BLOCKED', humanGate: { reasonCode: 'SAME', action: 'do it' } },
    { id: 'Y', status: 'COMPLETE', liveStatus: 'BLOCKED', humanGate: { reasonCode: 'SAME', action: 'do it' } }
  ];
  const items = blockedItemsOf(evaluated);
  assert.equal(items.length, 2);
  assert.equal(items[0].actionKey, 'SAME');
});

test('buildStatus returns the machine-readable state without secrets or live claims', () => {
  const status = buildStatus(REPO_ROOT);
  assert.equal(status.schema, 'clean-nano-remaining-work/1');
  assert.ok(status.completionPercent.code >= 0 && status.completionPercent.live === 0);
  assert.ok(Array.isArray(status.criticalPath));
  const serialized = JSON.stringify(status);
  // 値を伴う秘密の代入パターンだけを検査する（理由コード名の "TOKEN" などは対象外）。
  assert.doesNotMatch(serialized, /(password|client_?secret|api[_-]?key|bearer)\s*[:=]\s*\S/i);
});

// ---------- 実行器 ----------

test('independent tasks run in parallel waves and dependents run after their dependency', async () => {
  const order = [];
  const tasks = [
    { id: 'a', deps: [], files: [], system: 's' },
    { id: 'b', deps: [], files: [], system: 's' },
    { id: 'c', deps: ['a'], files: [], system: 's' }
  ];
  const executors = {
    a: async () => { order.push('a'); return { status: 'completed' }; },
    b: async () => { order.push('b'); return { status: 'completed' }; },
    c: async () => { order.push('c'); return { status: 'completed' }; }
  };
  const run = await runDag(tasks, executors, { maxParallel: 2 });
  assert.equal(run.counts.completed, 3);
  assert.ok(order.indexOf('c') > order.indexOf('a'));
});

test('a failed task isolates only its dependents and the other tasks still complete', async () => {
  const tasks = [
    { id: 'bad', deps: [], files: [], system: 's' },
    { id: 'child', deps: ['bad'], files: [], system: 's' },
    { id: 'ok', deps: [], files: [], system: 's' }
  ];
  const executors = {
    bad: async () => ({ status: 'failed', reasonCode: 'X_FAIL' }),
    child: async () => ({ status: 'completed' }),
    ok: async () => ({ status: 'completed' })
  };
  const run = await runDag(tasks, executors);
  assert.equal(run.results.bad.status, 'failed');
  assert.equal(run.results.ok.status, 'completed');
  assert.equal(run.results.child, undefined);
  assert.ok(run.waiting.includes('child'));
});

test('a thrown error is recorded only as a reason code and its message never reaches the state', async () => {
  const secret = 'Password=dummy-value-12345';
  const tasks = [{ id: 't', deps: [], files: [], system: 's' }];
  const executors = { t: async () => { throw new Error(`boom ${secret}`); } };
  const run = await runDag(tasks, executors);
  assert.equal(run.results.t.reasonCode, REASON_EXECUTOR_ERROR);
  assert.doesNotMatch(JSON.stringify(run), /dummy-value|boom/);
});

test('BLOCKED tasks go to one deduplicated human action bundle and do not count as failures', async () => {
  const tasks = [
    { id: 'p', deps: [], files: [], system: 's' },
    { id: 'q', deps: [], files: [], system: 's' },
    { id: 'after', deps: ['p'], files: [], system: 's' }
  ];
  const gate = { reasonCode: 'SAME_GATE', action: 'Grant once', actionKey: 'SAME_GATE' };
  const executors = {
    p: async () => ({ status: 'blocked', reasonCode: 'SAME_GATE', humanAction: gate }),
    q: async () => ({ status: 'blocked', reasonCode: 'SAME_GATE', humanAction: gate })
  };
  const run = await runDag(tasks, executors);
  assert.equal(run.counts.failed, 0);
  assert.equal(run.humanActionBundle.count, 1);
  assert.deepEqual(run.humanActionBundle.actions[0].sourceTasks, ['p', 'q']);
  assert.ok(run.waiting.includes('after'));
});

test('a safety stop halts only the same system and does not disturb a sibling in the same wave', async () => {
  const tasks = [
    { id: 'guard', deps: [], files: [], system: 'entra' },
    { id: 'sibling', deps: [], files: [], system: 'entra' },
    { id: 'other', deps: [], files: [], system: 'files' }
  ];
  const executors = {
    guard: async () => ({ status: 'completed', safetyStop: { system: 'entra', reasonCode: 'SAFETY_GATE' } }),
    sibling: async () => ({ status: 'completed' }),
    other: async () => ({ status: 'completed' })
  };
  const run = await runDag(tasks, executors, { maxParallel: 3 });
  assert.equal(run.results.guard.status, 'completed');
  assert.equal(run.results.sibling.status, 'completed');
  assert.equal(run.results.other.status, 'completed');
  assert.equal(run.safetyStops.length, 1);
  assert.equal(run.safetyStops[0].system, 'entra');
});

test('a task with no registered executor is failed with a reason code, not silently completed', async () => {
  const run = await runDag([{ id: 'orphan', deps: [], files: [], system: 's' }], {});
  assert.equal(run.results.orphan.status, 'failed');
  assert.equal(run.results.orphan.reasonCode, 'NO_EXECUTOR_REGISTERED');
});

// ---------- チェックポイント拡張 ----------

test('checkpoint requires the new completion, path, deferred and next-task fields', () => {
  const cp = buildCheckpoint({ goal: 'g', timestamp: '2026-11-07T00:00:00.000Z', ciStatus: 'success', lastGoodCommit: 'abc', testStatus: '1962 PASS', requiredHumanActions: [] });
  assert.equal(validateCheckpoint(cp).ok, true);
  assert.deepEqual(cp.completionPercent, { code: 0, live: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const file = path.join(dir, 'cp.json');
  const { criticalPath, ...withoutCritical } = cp;
  fs.writeFileSync(file, JSON.stringify(withoutCritical));
  const restored = restoreCheckpoint(file);
  assert.equal(restored.ok, false);
  assert.equal(restored.reasonCode, 'CHECKPOINT_INCOMPLETE');
  assert.deepEqual(restored.missing, ['criticalPath']);
  saveCheckpoint(path.join(dir, 'ok.json'), cp);
  assert.equal(restoreCheckpoint(path.join(dir, 'ok.json')).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
