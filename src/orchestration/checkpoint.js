'use strict';

// チェックポイント・BLOCKED の一括処理・自動再開（効率化基盤）。
// - チェックポイントは機械可読な JSON。必須項目が欠けていれば復元を拒否する。
// - BLOCKED は同じ人間操作をまとめる（重複排除）。提示は1つの操作セットとして行う。
// - 人間操作が済んだら、対応する BLOCKED を pending に戻して自動再開できる。

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FIELDS = Object.freeze([
  'goal', 'completedTasks', 'runningTasks', 'readyTasks', 'blockedTasks',
  'lastGoodCommit', 'testStatus', 'ciStatus', 'requiredHumanActions', 'timestamp'
]);

function buildCheckpoint(input) {
  const checkpoint = {
    schema: 'clean-nano-checkpoint/1',
    goal: input.goal,
    completedTasks: input.completedTasks || [],
    runningTasks: input.runningTasks || [],
    readyTasks: input.readyTasks || [],
    blockedTasks: input.blockedTasks || [],
    lastGoodCommit: input.lastGoodCommit ?? null,
    testStatus: input.testStatus ?? null,
    ciStatus: input.ciStatus ?? null,
    requiredHumanActions: input.requiredHumanActions || [],
    timestamp: input.timestamp || new Date().toISOString()
  };
  return checkpoint;
}

function validateCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return { ok: false, missing: [...REQUIRED_FIELDS] };
  const missing = REQUIRED_FIELDS.filter((field) => checkpoint[field] === undefined);
  return { ok: missing.length === 0, missing };
}

function saveCheckpoint(filePath, checkpoint) {
  const validation = validateCheckpoint(checkpoint);
  if (!validation.ok) throw new Error(`checkpoint missing fields: ${validation.missing.join(', ')}`);
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

function restoreCheckpoint(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, reasonCode: 'CHECKPOINT_NOT_FOUND', checkpoint: null };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return { ok: false, reasonCode: 'CHECKPOINT_INVALID_JSON', checkpoint: null }; }
  const validation = validateCheckpoint(parsed);
  if (!validation.ok) return { ok: false, reasonCode: 'CHECKPOINT_INCOMPLETE', missing: validation.missing, checkpoint: null };
  return { ok: true, reasonCode: null, checkpoint: parsed };
}

// BLOCKED を人間操作ごとに重複排除する。同じ actionKey の操作は1件にまとめ、起因タスクを束ねる。
function collectBlocked(blockedItems) {
  const byKey = new Map();
  for (const item of blockedItems) {
    const key = item.actionKey || `${item.reasonCode}:${item.action}`;
    if (!byKey.has(key)) byKey.set(key, { actionKey: key, action: item.action, reasonCode: item.reasonCode, sourceTasks: [] });
    const entry = byKey.get(key);
    if (!entry.sourceTasks.includes(item.taskId)) entry.sourceTasks.push(item.taskId);
  }
  return [...byKey.values()];
}

// 人間に依頼する操作セット（最後に1回で提示する）。
function humanActionBundle(blockedItems) {
  const actions = collectBlocked(blockedItems);
  return { count: actions.length, actions: actions.map((a, i) => ({ step: i + 1, ...a })) };
}

// 人間操作が完了したキーに対応する BLOCKED タスクを pending に戻す。戻したタスクIDを返す。
function autoResume(blockedItems, completedActionKeys) {
  const done = new Set(completedActionKeys);
  const resumed = [];
  const remaining = [];
  for (const item of blockedItems) {
    const key = item.actionKey || `${item.reasonCode}:${item.action}`;
    if (done.has(key)) resumed.push(item.taskId);
    else remaining.push(item);
  }
  return { resumed, remaining };
}

module.exports = { REQUIRED_FIELDS, buildCheckpoint, validateCheckpoint, saveCheckpoint, restoreCheckpoint, collectBlocked, humanActionBundle, autoResume };
