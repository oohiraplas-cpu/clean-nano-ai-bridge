'use strict';

// チェックポイント・BLOCKED の一括処理・自動再開（効率化基盤）。
// - チェックポイントは機械可読な JSON。必須項目が欠けていれば復元を拒否する。
// - BLOCKED は同じ人間操作をまとめる（重複排除）。提示は1つの操作セットとして行う。
// - 人間操作が済んだら、対応する BLOCKED を pending に戻して自動再開できる。

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FIELDS = Object.freeze([
  'schema', 'goal', 'completedTasks', 'runningTasks', 'readyTasks', 'blockedTasks',
  'lastGoodCommit', 'testStatus', 'ciStatus', 'requiredHumanActions', 'timestamp',
  'completionPercent', 'criticalPath', 'deferredTasks', 'nextAutoTasks'
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
    timestamp: input.timestamp || new Date().toISOString(),
    // completionPercent は { code, live } の形（コード完了と実環境検証を分ける）。
    completionPercent: input.completionPercent ?? { code: 0, live: 0 },
    criticalPath: input.criticalPath || [],
    deferredTasks: input.deferredTasks || [],
    nextAutoTasks: input.nextAutoTasks || []
  };
  return checkpoint;
}

function validateCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return { ok: false, missing: [...REQUIRED_FIELDS], invalid: [] };
  const missing = REQUIRED_FIELDS.filter((field) => checkpoint[field] === undefined);
  const invalid = [];
  const check = (field, valid) => { if (!missing.includes(field) && !valid) invalid.push(field); };
  const nonemptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  check('schema', checkpoint.schema === 'clean-nano-checkpoint/1');
  check('goal', nonemptyString(checkpoint.goal));
  for (const field of ['lastGoodCommit', 'testStatus', 'ciStatus']) {
    check(field, checkpoint[field] === null || nonemptyString(checkpoint[field]));
  }
  for (const field of ['completedTasks', 'runningTasks', 'readyTasks', 'blockedTasks', 'requiredHumanActions', 'criticalPath', 'deferredTasks', 'nextAutoTasks']) {
    check(field, Array.isArray(checkpoint[field]) && checkpoint[field].every(nonemptyString));
  }
  check('timestamp', typeof checkpoint.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(checkpoint.timestamp) && Number.isFinite(Date.parse(checkpoint.timestamp)));
  const percent = checkpoint.completionPercent;
  check('completionPercent', percent !== null && typeof percent === 'object' && !Array.isArray(percent) &&
    ['code', 'live'].every((key) => Number.isFinite(percent[key]) && percent[key] >= 0 && percent[key] <= 100));
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

function saveCheckpoint(filePath, checkpoint) {
  const validation = validateCheckpoint(checkpoint);
  if (!validation.ok) throw new Error(`checkpoint missing fields: ${validation.missing.join(', ')}; invalid fields: ${validation.invalid.join(', ')}`);
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
  if (!validation.ok) return { ok: false, reasonCode: validation.missing.length ? 'CHECKPOINT_INCOMPLETE' : 'CHECKPOINT_INVALID_FIELDS', missing: validation.missing, invalid: validation.invalid, checkpoint: null };
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
