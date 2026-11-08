'use strict';
// Windows Executor job queue (CNAI -> Bridge -> Windows Executor).
//
// Scope: in-process state only (like executionQueue; a Bridge restart clears it).
// Because of that, executors are re-registered implicitly on heartbeat/pull, so a Bridge
// restart does not leave a healthy executor permanently "unregistered" (Auto Resume).
//
// Safety rules:
//  - LOW / MEDIUM jobs are queued automatically; HIGH / CRITICAL stay WAITING_FOR_APPROVAL
//    and are never handed to an executor by this module.
//  - A taskId is accepted once. A duplicate submit never creates or re-runs a job.
//  - Checkpoints/results are refused for jobs that already reached a terminal status.
//  - Free text that is stored or echoed back is passed through secret masking.

const crypto = require('node:crypto');
const { maskDeep, maskSecrets } = require('./secretMasking');

const RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const AUTO_RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM']);
const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'REJECTED', 'BLOCKED']);
// The Windows Executor reports COMPLETED, BLOCKED (unsupported action) or WAITING_FOR_APPROVAL.
const RESULT_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'REJECTED', 'BLOCKED', 'WAITING_FOR_APPROVAL']);
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXECUTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ACTION_LENGTH = 1000;
const MAX_WORKSPACE_LENGTH = 500;
const MAX_CHECKPOINT_HISTORY = 100;

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createWindowsJobState() {
  return { jobs: new Map(), executors: new Map() };
}

// Process-wide queue used by the HTTP routes and the MCP tool.
const defaultState = createWindowsJobState();

function now() {
  return new Date().toISOString();
}

function asTrimmedString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizeRiskLevel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return RISK_LEVELS.includes(normalized) ? normalized : null;
}

function readExecutorId(source) {
  const executorId = asTrimmedString(source?.executorId, source?.executor_id);
  if (!executorId) throw requestError('executorIdは必須です');
  if (!EXECUTOR_ID_PATTERN.test(executorId)) throw requestError('executorIdの形式が不正です');
  return executorId;
}

function readTaskId(source) {
  const taskId = asTrimmedString(source?.taskId, source?.task_id);
  if (!taskId) throw requestError('taskIdは必須です');
  if (!TASK_ID_PATTERN.test(taskId)) throw requestError('taskIdの形式が不正です');
  return taskId;
}

function createExecutorRecord(executorId, payload = {}, previous = null) {
  const timestamp = now();
  return {
    executorId,
    version: asTrimmedString(payload.version) || previous?.version || 'unknown',
    capabilities: Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((item) => typeof item === 'string').slice(0, 32)
      : (previous?.capabilities || []),
    status: previous?.status || 'IDLE',
    currentTask: previous?.currentTask || null,
    registeredAt: previous?.registeredAt || timestamp,
    lastHeartbeatAt: timestamp
  };
}

/** Explicit register (executor start-up). Jobs the previous process left RUNNING are re-queued. */
function registerExecutor(state, body = {}) {
  const executorId = readExecutorId(body);
  const previous = state.executors.get(executorId) || null;
  const executor = createExecutorRecord(executorId, body, previous);
  executor.status = 'IDLE';
  executor.currentTask = null;
  state.executors.set(executorId, executor);

  // The registering process is a fresh process: whatever it was running before is no longer running.
  const resumed = [];
  for (const job of state.jobs.values()) {
    if (job.status === 'RUNNING' && job.claimedBy === executorId) {
      job.status = 'QUEUED';
      job.resumed = true;
      job.updatedAt = now();
      resumed.push(job.taskId);
    }
  }
  return { accepted: true, executorId, status: 'REGISTERED', executor, resumedTasks: resumed };
}

function ensureExecutor(state, executorId, payload) {
  let executor = state.executors.get(executorId);
  let reRegistered = false;
  if (!executor) {
    executor = createExecutorRecord(executorId, payload || {});
    state.executors.set(executorId, executor);
    reRegistered = true;
  }
  return { executor, reRegistered };
}

function heartbeatExecutor(state, body = {}) {
  const executorId = readExecutorId(body);
  const { executor, reRegistered } = ensureExecutor(state, executorId, body);
  executor.lastHeartbeatAt = now();
  const status = asTrimmedString(body.status);
  if (status) executor.status = status.toUpperCase().slice(0, 32);
  if (body.currentTask === null) executor.currentTask = null;
  else if (typeof body.currentTask === 'string') executor.currentTask = body.currentTask.slice(0, 128);
  return { accepted: true, executorId, status: 'OK', reRegistered, executor };
}

function createWindowsJobRecord(taskId, action, workspace, riskLevel, source) {
  const waiting = !AUTO_RISK_LEVELS.includes(riskLevel);
  const timestamp = now();
  return {
    taskId,
    action,
    workspace,
    riskLevel,
    source,
    status: waiting ? 'WAITING_FOR_APPROVAL' : 'QUEUED',
    accepted: true,
    claimedBy: null,
    resumed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastCheckpoint: null,
    checkpointHistory: [],
    resumeToken: null,
    result: null
  };
}

function submitWindowsJob(state, params = {}, source = 'submit') {
  const given = asTrimmedString(params.taskId, params.task_id);
  const taskId = given || crypto.randomUUID();
  if (!TASK_ID_PATTERN.test(taskId)) throw requestError('taskIdの形式が不正です');
  const action = asTrimmedString(params.action) || '';
  const workspace = asTrimmedString(params.workspace) || '';
  const riskLevel = normalizeRiskLevel(params.riskLevel ?? params.risk_level ?? 'LOW');
  if (!action) throw requestError('actionは必須です');
  if (!workspace) throw requestError('workspaceは必須です');
  if (action.length > MAX_ACTION_LENGTH) throw requestError(`actionは${MAX_ACTION_LENGTH}文字以内にしてください`);
  if (workspace.length > MAX_WORKSPACE_LENGTH) throw requestError(`workspaceは${MAX_WORKSPACE_LENGTH}文字以内にしてください`);
  if (!riskLevel) throw requestError('riskLevelはLOW, MEDIUM, HIGH, CRITICALのいずれかである必要があります');

  const existing = state.jobs.get(taskId);
  if (existing) {
    // Never re-run or overwrite: the caller learns the current state of the original job.
    return { taskId, accepted: false, duplicate: true, status: existing.status, reason: 'taskId already exists' };
  }
  const job = createWindowsJobRecord(taskId, maskSecrets(action), maskSecrets(workspace), riskLevel, source);
  state.jobs.set(taskId, job);
  return { taskId, accepted: true, status: job.status };
}

function pullWindowsJob(state, executorId) {
  const { executor } = ensureExecutor(state, executorId);
  executor.lastHeartbeatAt = now();
  for (const job of state.jobs.values()) {
    if (job.status !== 'QUEUED') continue;
    if (!AUTO_RISK_LEVELS.includes(job.riskLevel)) continue; // defence in depth; HIGH/CRITICAL are never QUEUED
    if (job.claimedBy && job.claimedBy !== executorId) continue;
    job.claimedBy = executorId;
    job.status = 'RUNNING';
    job.updatedAt = now();
    executor.currentTask = job.taskId;
    executor.status = 'RUNNING';
    return { job, status: job.resumed ? 'resumed' : 'assigned' };
  }
  return { job: null, status: 'idle' };
}

function getRunningJob(state, taskId) {
  const job = state.jobs.get(taskId);
  if (!job) throw requestError('ジョブが見つかりません', 404);
  if (TERMINAL_STATUSES.includes(job.status)) throw requestError(`ジョブは既に終了しています（${job.status}）`, 409);
  if (job.status !== 'RUNNING') throw requestError(`ジョブは実行中ではありません（${job.status}）`, 409);
  return job;
}

function checkpointWindowsJob(state, payload = {}) {
  const taskId = readTaskId(payload);
  const job = getRunningJob(state, taskId);
  // resumeToken is an opaque resume position, not a credential. The generic masker treats any key named
  // "*token*" as a secret and would destroy it, so it is validated by format instead of being masked.
  const given = asTrimmedString(payload.resumeToken);
  if (given && (!RESUME_TOKEN_PATTERN.test(given) || maskSecrets(given) !== given)) throw requestError('resumeTokenの形式が不正です');
  const checkpoint = {
    ...maskDeep({
      taskId,
      stage: asTrimmedString(payload.status) || 'CHECKPOINT',
      completedSteps: Array.isArray(payload.completedSteps) ? payload.completedSteps.slice(0, 200) : [],
      nextStep: asTrimmedString(payload.nextStep),
      changedFiles: Array.isArray(payload.changedFiles) ? payload.changedFiles.slice(0, 500) : [],
      testStatus: asTrimmedString(payload.testStatus) || 'PENDING',
      timestamp: asTrimmedString(payload.timestamp) || now()
    }),
    resumeToken: given || job.resumeToken
  };
  job.lastCheckpoint = checkpoint;
  job.resumeToken = checkpoint.resumeToken || job.resumeToken;
  job.checkpointHistory.push(checkpoint);
  if (job.checkpointHistory.length > MAX_CHECKPOINT_HISTORY) job.checkpointHistory.shift();
  job.updatedAt = now();
  return { taskId, status: job.status, checkpoint };
}

function resultWindowsJob(state, payload = {}) {
  const taskId = readTaskId(payload);
  const job = getRunningJob(state, taskId);
  const finalStatus = asTrimmedString(payload.status)?.toUpperCase() || 'COMPLETED';
  if (!RESULT_STATUSES.includes(finalStatus)) throw requestError(`statusは${RESULT_STATUSES.join(', ')}のいずれかである必要があります`);
  job.status = finalStatus;
  job.result = maskDeep({
    taskId,
    executorId: asTrimmedString(payload.executorId) || job.claimedBy,
    status: finalStatus,
    summary: payload.summary ?? null,
    output: payload.output ?? null,
    evidence: payload.evidence ?? null,
    reason: payload.reason ?? null,
    changedFiles: Array.isArray(payload.changedFiles) ? payload.changedFiles.slice(0, 500) : [],
    timestamp: asTrimmedString(payload.timestamp) || now(),
    exitCode: Number.isInteger(payload.exitCode) ? payload.exitCode : null
  });
  job.updatedAt = now();
  const executor = job.claimedBy ? state.executors.get(job.claimedBy) : null;
  if (executor && executor.currentTask === taskId) {
    executor.currentTask = null;
    executor.status = 'IDLE';
  }
  return { taskId, status: job.status, result: job.result };
}

function getWindowsJob(state, taskId) {
  const job = state.jobs.get(taskId);
  if (!job) throw requestError('ジョブが見つかりません', 404);
  return job;
}

module.exports = {
  RISK_LEVELS,
  TERMINAL_STATUSES,
  defaultState,
  createWindowsJobState,
  normalizeRiskLevel,
  readExecutorId,
  registerExecutor,
  heartbeatExecutor,
  submitWindowsJob,
  pullWindowsJob,
  checkpointWindowsJob,
  resultWindowsJob,
  getWindowsJob
};
