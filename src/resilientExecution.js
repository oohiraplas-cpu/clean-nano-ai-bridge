'use strict';
// CNAI Resilient Execution: Checkpoint / Retry / Failover / Auto Resume / Verify.
// 既存のJob構造（steps配列）に依存せず、純粋なJSON jobオブジェクトに対して動作する。
// 成功済み工程は再実行せず、直近Checkpointから再開する。Secretは保存前にマスクする。
const fs = require('node:fs');
const path = require('node:path');
const { maskSecrets } = require('./secretMasking');

const RESILIENT_STATES = Object.freeze([
  'AUTH_BLOCKED', 'RATE_LIMITED', 'EXECUTOR_OFFLINE', 'NETWORK_ERROR', 'TEST_FAILED',
  'AI_UNAVAILABLE', 'CHECKPOINTED', 'RETRYING', 'BLOCKED', 'COMPLETED',
]);
// 自動再試行してよい状態（認証系は人間介入が必要なので再試行しない）
const RETRYABLE = new Set(['RATE_LIMITED', 'EXECUTOR_OFFLINE', 'NETWORK_ERROR', 'AI_UNAVAILABLE', 'TEST_FAILED']);
// フェイルオーバー（別executor/provider）で改善し得る状態
const FAILOVER = new Set(['EXECUTOR_OFFLINE', 'AI_UNAVAILABLE', 'RATE_LIMITED']);

function classifyFailure(err) {
  const status = Number(err && (err.status || err.statusCode));
  const code = String((err && err.code) || '');
  const state = err && err.resilientState;
  if (RESILIENT_STATES.includes(state)) return state;
  if (status === 401 || status === 403) return 'AUTH_BLOCKED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503 || status === 529 || status === 502) return 'AI_UNAVAILABLE';
  if (['ECONNREFUSED', 'EHOSTUNREACH'].includes(code)) return 'EXECUTOR_OFFLINE';
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) return 'NETWORK_ERROR';
  if (err && err.name === 'VerifyError') return 'TEST_FAILED';
  return 'BLOCKED';
}

class VerifyError extends Error {
  constructor(message) { super(message); this.name = 'VerifyError'; }
}

function createJob({ id, steps, targets = ['primary'], maxAttempts = 3 }) {
  if (!id || !Array.isArray(steps) || steps.length === 0) throw new Error('id と steps は必須です');
  const names = steps.map((s) => (typeof s === 'string' ? s : s.name));
  if (new Set(names).size !== names.length) throw new Error('step名が重複しています');
  return {
    id, steps: names, targets: [...targets], targetIndex: 0, maxAttempts,
    status: 'CHECKPOINTED', completedSteps: [], checkpoints: [], attempts: {}, history: [],
    updatedAt: new Date().toISOString(),
  };
}

function record(job, state, detail) {
  job.status = state;
  job.updatedAt = new Date().toISOString();
  job.history.push({ at: job.updatedAt, state, ...detail });
}

function nextStep(job) {
  return job.steps.find((s) => !job.completedSteps.includes(s)) || null;
}

function saveJob(file, job) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, file); // アトミック置換（破損防止）
}

function loadJob(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// handlers: { [step]: async ({job, target, checkpoints}) => result }
// verifiers: { [step]: async (result, ctx) => boolean|void } falseまたはthrowでTEST_FAILED
async function runJob(job, handlers, { verifiers = {}, persist = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), baseDelayMs = 500 } = {}) {
  // Auto Resume: completedSteps/checkpointsを信頼し、未完了工程から再開する
  if (job.status === 'COMPLETED') return job;
  if (job.status === 'AUTH_BLOCKED' || job.status === 'BLOCKED') {
    record(job, 'RETRYING', { reason: 'resume', from: nextStep(job) });
  }
  for (let step = nextStep(job); step; step = nextStep(job)) {
    const handler = handlers[step];
    if (typeof handler !== 'function') {
      record(job, 'BLOCKED', { step, reason: 'handler未定義' });
      persist(job);
      return job;
    }
    for (;;) {
      const target = job.targets[job.targetIndex % job.targets.length];
      job.attempts[step] = (job.attempts[step] || 0) + 1;
      try {
        const result = await handler({ job, target, checkpoints: job.checkpoints });
        const verify = verifiers[step];
        if (verify) {
          const ok = await verify(result, { job, target });
          if (ok === false) throw new VerifyError(`検証失敗: ${step}`);
        }
        job.completedSteps.push(step);
        job.checkpoints.push({ step, at: new Date().toISOString(), target, attempt: job.attempts[step] });
        record(job, 'CHECKPOINTED', { step, target });
        persist(job);
        break;
      } catch (err) {
        const state = classifyFailure(err);
        const msg = maskSecrets(String((err && err.message) || err));
        record(job, state, { step, target, attempt: job.attempts[step], message: msg });
        persist(job);
        if (!RETRYABLE.has(state) || job.attempts[step] >= job.maxAttempts) {
          if (state !== 'AUTH_BLOCKED') record(job, 'BLOCKED', { step, reason: RETRYABLE.has(state) ? '再試行上限' : '自動復旧不可' });
          persist(job);
          return job;
        }
        if (FAILOVER.has(state) && job.targets.length > 1) job.targetIndex += 1; // Failover
        record(job, 'RETRYING', { step, next: job.targets[job.targetIndex % job.targets.length] });
        persist(job);
        await sleep(baseDelayMs * 2 ** (job.attempts[step] - 1));
      }
    }
  }
  record(job, 'COMPLETED', {});
  persist(job);
  return job;
}

module.exports = { RESILIENT_STATES, classifyFailure, createJob, runJob, saveJob, loadJob, nextStep, VerifyError };
