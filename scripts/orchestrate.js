#!/usr/bin/env node
'use strict';

// 残作業DAGの状態を出力する（読取り専用・外部サービスには接続しない）。
// 使い方:
//   node scripts/orchestrate.js status                 # 状態を標準出力へ JSON で出す
//   node scripts/orchestrate.js status --checkpoint <path>   # チェックポイントも保存する
// 秘密値は扱わない。出力は証跡ファイルの存在と定義だけから作る。

const path = require('node:path');
const { evaluateTasks, computeCriticalPath, completionPercent, blockedItemsOf } = require('../src/orchestration/remainingWork');
const { collectBlocked, humanActionBundle, buildCheckpoint, saveCheckpoint } = require('../src/orchestration/checkpoint');

const REPO_ROOT = path.resolve(__dirname, '..');

function buildStatus(repoRoot = REPO_ROOT) {
  const tasks = evaluateTasks(repoRoot);
  const criticalPath = computeCriticalPath(tasks);
  const percent = completionPercent(tasks);
  const blockedItems = blockedItemsOf(tasks);
  const blocked = collectBlocked(blockedItems);
  const bundle = humanActionBundle(blockedItems);
  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return {
    schema: 'clean-nano-remaining-work/1',
    completionPercent: percent,
    counts,
    criticalPath,
    tasks,
    blocked,
    humanActionBundle: bundle,
    deferredTasks: tasks.filter((t) => t.status === 'DEFERRED').map((t) => t.id),
    // 次に自動で進められるのは、依存が満たされたコード側のタスク。実環境の人間操作待ち（liveStatus）は止めない。
    nextAutoTasks: tasks.filter((t) => t.status === 'READY').map((t) => t.id)
  };
}

function toCheckpoint(status, { lastGoodCommit = null, testStatus = null, ciStatus = null } = {}) {
  return buildCheckpoint({
    goal: 'Clean Nano Operations MCP 100%（残作業DAG）',
    completedTasks: status.tasks.filter((t) => t.status === 'COMPLETE').map((t) => t.id),
    runningTasks: [],
    readyTasks: status.tasks.filter((t) => t.status === 'READY').map((t) => t.id),
    blockedTasks: status.blocked.map((b) => b.sourceTasks.join(',')),
    lastGoodCommit,
    testStatus,
    ciStatus,
    requiredHumanActions: status.humanActionBundle.actions.map((a) => a.action),
    completionPercent: status.completionPercent,
    criticalPath: status.criticalPath,
    deferredTasks: status.deferredTasks,
    nextAutoTasks: status.nextAutoTasks
  });
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'status') {
    process.stderr.write('usage: node scripts/orchestrate.js status [--checkpoint <path>]\n');
    return 2;
  }
  const status = buildStatus();
  const idx = rest.indexOf('--checkpoint');
  if (idx !== -1) {
    const file = rest[idx + 1];
    if (!file) { process.stderr.write('--checkpoint requires a path\n'); return 2; }
    saveCheckpoint(path.resolve(file), toCheckpoint(status));
  }
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { buildStatus, toCheckpoint, main };
