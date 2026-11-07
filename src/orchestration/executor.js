'use strict';

// DAG 実行器。既存の taskGraph / checkpoint を組み合わせて、タスクを依存順・並列上限付きで実行する。
// - 準備ができたタスクを波（wave）単位で並列実行する。同じファイルを触るタスクは同時に走らせない（taskGraph 側）。
// - 失敗はそのタスクと依存先だけを隔離し、他の正常タスクは続ける。
// - BLOCKED（人間操作待ち）は失敗扱いにせず、人間操作ごとに1件へまとめて返す。
// - 失敗理由は reasonCode のみを記録する。例外のメッセージは状態に入れない（秘密値の混入防止）。
// - 安全条件の失敗（safetyStop）は、同じ system の未完了タスクだけを停止する。

const { createTaskGraph } = require('./taskGraph');
const { collectBlocked, humanActionBundle } = require('./checkpoint');

const REASON_EXECUTOR_ERROR = 'EXECUTOR_ERROR';
const REASON_NO_EXECUTOR = 'NO_EXECUTOR_REGISTERED';

// tasks: [{ id, deps, files, system }]
// executors: { [id]: async () => ({ status: 'completed'|'blocked', result?, reasonCode?, humanAction?, safetyStop? }) }
async function runDag(tasks, executors = {}, { maxParallel = 3, onEvent = () => {} } = {}) {
  const graph = createTaskGraph(tasks, { maxParallel });
  const results = {};
  const blockedItems = [];
  const safetyStops = [];

  const runOne = async (id) => {
    const executor = executors[id];
    if (typeof executor !== 'function') {
      return { id, outcome: { status: 'failed', reasonCode: REASON_NO_EXECUTOR } };
    }
    try {
      const outcome = await executor();
      return { id, outcome: outcome || { status: 'failed', reasonCode: REASON_EXECUTOR_ERROR } };
    } catch {
      // 例外の内容は記録しない。
      return { id, outcome: { status: 'failed', reasonCode: REASON_EXECUTOR_ERROR } };
    }
  };

  for (;;) {
    const started = graph.startReady();
    if (started.length === 0) break;
    onEvent({ type: 'wave', tasks: started });
    const settled = await Promise.all(started.map(runOne));
    const waveStops = [];
    for (const { id, outcome } of settled) {
      if (outcome.status === 'completed') {
        graph.complete(id, null);
        results[id] = { status: 'completed' };
        onEvent({ type: 'completed', task: id });
      } else if (outcome.status === 'blocked') {
        graph.block(id, outcome.reasonCode || 'HUMAN_ACTION_REQUIRED', outcome.humanAction || null);
        results[id] = { status: 'blocked', reasonCode: outcome.reasonCode || 'HUMAN_ACTION_REQUIRED' };
        blockedItems.push({
          taskId: id,
          reasonCode: outcome.reasonCode || 'HUMAN_ACTION_REQUIRED',
          action: outcome.humanAction?.action || outcome.reasonCode || 'HUMAN_ACTION_REQUIRED',
          actionKey: outcome.humanAction?.actionKey || outcome.reasonCode || 'HUMAN_ACTION_REQUIRED'
        });
        onEvent({ type: 'blocked', task: id });
      } else {
        const reasonCode = outcome.reasonCode || REASON_EXECUTOR_ERROR;
        const failure = graph.fail(id, reasonCode);
        results[id] = { status: 'failed', reasonCode, isolated: failure.isolated };
        onEvent({ type: 'failed', task: id, reasonCode });
      }
      if (outcome.safetyStop && outcome.safetyStop.system) waveStops.push(outcome.safetyStop);
    }
    // 同じ波の結果をすべて記録した後で停止を適用する（記録前に running を stopped にしない）。
    for (const stop of waveStops) {
      const reasonCode = stop.reasonCode || 'SAFETY_STOP';
      const stopped = graph.stopSystem(stop.system, reasonCode);
      safetyStops.push({ system: stop.system, reasonCode, stopped });
    }
  }

  const graphJson = graph.toJSON();
  return {
    schema: 'clean-nano-dag-run/1',
    counts: graphJson.counts,
    results,
    safetyStops,
    graph: graphJson,
    blocked: collectBlocked(blockedItems),
    humanActionBundle: humanActionBundle(blockedItems),
    // 完了していないタスク（依存先がブロック・失敗で待機）を残す。
    waiting: graphJson.tasks.filter((t) => t.state === 'pending' || t.state === 'isolated').map((t) => t.id)
  };
}

module.exports = { runDag, REASON_EXECUTOR_ERROR, REASON_NO_EXECUTOR };
