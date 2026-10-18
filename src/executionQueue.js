/**
 * Execution Queue
 *
 * エージェントへの実行依頼を受け付け、優先順位付きで管理する。
 * - 依頼は Agent Registry に登録されたエージェントと、その allowedTools の範囲に限定する。
 * - 人間承認が必要なステップは、SharePoint 承認台帳で人間の承認を確認してから進む。
 *   承認フラグ（approvedByHuman など）による承認は存在しない。承認が確認できなければ「人間承認待ち」で止まる。
 * - チェックポイントは完了したステップ数で保持し、停止後はそこから再開する。
 * - store を渡すと、依頼・チェックポイント・ステップ状態・監査履歴を永続化し、再起動後に復元する。
 *   冪等キー（idempotencyKey）で同じ依頼の二重登録を防ぎ、実行ロックで同じ依頼の二重実行を防ぐ。
 * - executor を渡すと、ステップごとに実ツールを実行し、結果を検証してから完了にする（Result Verifier）。
 *   接続のないツールは BLOCKED_TOOL_CONNECTION として、他の依頼は継続させる。
 * - executor を渡さない場合は状態遷移のみ（従来どおり、外部には触れない）。
 */

const crypto = require('node:crypto');
const { AGENT_DEFINITIONS } = require('./agentRegistry');
const { validateDependencies, readySteps } = require('./dependencyGraph');
const { BLOCKED_TOOL_CONNECTION } = require('./toolExecutor');

const PRIORITY_ORDER = Object.freeze({ high: 0, normal: 1, low: 2 });
const TERMINAL_STATUSES = Object.freeze(['完了', '停止']);
const REQUEST_STATUSES = Object.freeze(['待機中', '実行中', '人間承認待ち', 'BLOCKED_TOOL_CONNECTION', '完了', '停止']);
const DEFAULT_LOCK_TTL_MS = 60 * 1000;

function requestError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFoundError(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

/**
 * 実行依頼の入力を検証する。
 * @returns {string|null} エラーメッセージ（問題なければ null）
 */
function validateExecutionRequest(input, agents = AGENT_DEFINITIONS) {
  if (!input || typeof input !== 'object') return '入力が不正です';
  const agent = agents.find((item) => item.id === input.agentId);
  if (!agent) return `未登録のエージェントです: ${String(input.agentId)}`;
  if (!Array.isArray(input.steps) || input.steps.length === 0) return 'steps は1件以上の配列で指定してください';
  if (input.steps.length > 50) return 'steps は50件以下にしてください';
  for (const step of input.steps) {
    if (!step || typeof step.tool !== 'string') return '各stepには tool（文字列）が必要です';
    if (!agent.allowedTools.includes(step.tool)) return `${agent.id} は ${step.tool} を使用できません`;
  }
  const dependencyProblem = validateDependencies(input.steps);
  if (dependencyProblem) return dependencyProblem;
  if (input.priority !== undefined && !(input.priority in PRIORITY_ORDER)) return 'priority は high / normal / low のいずれかです';
  if (input.idempotencyKey !== undefined) {
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 128) {
      return 'idempotencyKey は1〜128文字の文字列で指定してください';
    }
  }
  return null;
}

class ExecutionQueue {
  /**
   * @param {object} options
   * @param {object} [options.ledger] - ApprovalLedger（承認台帳）。未指定なら承認は得られない（fail closed）。
   * @param {object} [options.store] - ExecutionStore（永続化）。未指定ならメモリ上のみ。
   * @param {object} [options.executor] - ToolExecutor（実ツール実行器）。未指定なら状態遷移のみ。
   * @param {string} [options.owner] - 実行ロックの持ち主（プロセスごとに一意）
   * @param {number} [options.lockTtlMs] - 実行ロックの有効期限
   */
  constructor({
    agents = AGENT_DEFINITIONS,
    now = () => new Date(),
    ledger = null,
    store = null,
    executor = null,
    owner = crypto.randomUUID(),
    lockTtlMs = DEFAULT_LOCK_TTL_MS
  } = {}) {
    this.agents = agents;
    this.now = now;
    this.ledger = ledger;
    this.store = store;
    this.executor = executor;
    this.owner = owner;
    this.lockTtlMs = lockTtlMs;
    this.requests = new Map();
    this.inFlight = new Set();
    this.sequence = 0;
    if (this.store) this.restore();
  }

  /**
   * 保存済みの依頼を復元する。
   * 実行中のまま中断された手順は、実行されたかどうか不明なため自動再実行しない（停止して確認を求める）。
   */
  restore() {
    this.store.clearLocks();
    for (const record of this.store.listRequests()) {
      this.requests.set(record.id, record);
      this.sequence = Math.max(this.sequence, record.sequence || 0);
      if (record.steps.some((step) => step.status === '実行中')) {
        record.status = '停止';
        record.stopReason = 'recovery_requires_verification';
        this.touch(record);
        this.persist(record);
        this.audit(record, 'recovered_interrupted', { reason: 'step_in_progress_at_restart' });
      }
    }
  }

  /** 実行依頼を登録する。同じ idempotencyKey の依頼が既にあれば、新規作成せず既存を返す。 */
  createRequest(input) {
    const problem = validateExecutionRequest(input, this.agents);
    if (problem) throw requestError(problem);
    const key = input.idempotencyKey;
    if (key !== undefined && this.store) {
      const existing = this.store.findByIdempotencyKey(key);
      if (existing) {
        this.audit(existing, 'duplicate_create_ignored', { idempotencyKey: key });
        return this.snapshot(existing);
      }
    }
    const agent = this.agents.find((item) => item.id === input.agentId);
    const id = crypto.randomUUID();
    const steps = input.steps.map((step, index) => ({
      index,
      tool: step.tool,
      dependsOn: Array.isArray(step.dependsOn) ? [...step.dependsOn] : [],
      approvalRequired: agent.humanApprovalRequired.includes(step.tool),
      approved: false,
      status: '未着手'
    }));
    const request = {
      id,
      agentId: agent.id,
      priority: input.priority || 'normal',
      sequence: ++this.sequence,
      idempotencyKey: key || null,
      status: steps.some((step) => step.approvalRequired) ? '人間承認待ち' : '待機中',
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      steps,
      checkpoint: { completedSteps: 0, lastCompletedTool: null, updatedAt: null },
      rollbackPoint: null
    };
    this.requests.set(id, request);
    if (key !== undefined && this.store) this.store.bindIdempotencyKey(key, id);
    this.persist(request);
    this.audit(request, 'created', { steps: steps.length });
    return this.snapshot(request);
  }

  /** 実行待ちの依頼を、優先順位（high→normal→low）と登録順で返す。 */
  getQueue() {
    const pending = [...this.requests.values()]
      .filter((request) => !TERMINAL_STATUSES.includes(request.status))
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.sequence - b.sequence);
    return pending.map((request, position) => ({ position: position + 1, ...this.snapshot(request) }));
  }

  getStatus(requestId) {
    return this.snapshot(this.find(requestId));
  }

  getCheckpoint(requestId) {
    const request = this.find(requestId);
    return { requestId: request.id, status: request.status, ...request.checkpoint, totalSteps: request.steps.length };
  }

  /** 依頼の監査履歴（Execution History）を返す。 */
  getAudit(requestId) {
    this.find(requestId);
    return this.store ? this.store.listAudit(requestId) : [];
  }

  /**
   * 次の実行可能なステップを1件進める。
   * - 依頼単位で排他する（同時実行は 409）。
   * - 承認が必要なステップは、承認台帳で人間の承認を確認してから進む。
   * - executor がある場合は実ツールを実行し、検証済みの結果だけを完了にする。
   */
  async advance(requestId) {
    const request = this.find(requestId);
    if (TERMINAL_STATUSES.includes(request.status)) throw requestError(`終了済みの依頼です（${request.status}）`);
    if (this.inFlight.has(request.id)) throw conflictError('この依頼は別の処理が実行中です');
    if (this.store && !this.store.acquireLock(request.id, this.owner, this.lockTtlMs)) {
      throw conflictError('この依頼は別の処理が実行中です（実行ロック）');
    }
    this.inFlight.add(request.id);
    try {
      return await this.advanceLocked(request);
    } finally {
      this.inFlight.delete(request.id);
      if (this.store) this.store.releaseLock(request.id, this.owner);
    }
  }

  async advanceLocked(request) {
    const step = readySteps(request.steps)[0];
    if (!step) {
      if (request.steps.every((item) => item.status === '完了')) {
        request.status = '完了';
        this.audit(request, 'completed', {});
      } else {
        request.status = '停止';
        request.stopReason = 'dependency_unsatisfied';
        this.audit(request, 'stopped', { reason: 'dependency_unsatisfied' });
      }
      return this.commit(request);
    }

    if (step.approvalRequired && !step.approved) {
      const check = this.ledger
        ? await this.ledger.check({ requestId: request.id, stepIndex: step.index, tool: step.tool })
        : { approved: false, reason: 'ledger_not_configured' };
      if (!check.approved) {
        request.status = '人間承認待ち';
        request.approvalReason = check.reason;
        this.audit(request, 'approval_pending', { stepIndex: step.index, reason: check.reason });
        return this.commit(request);
      }
      step.approved = true;
      request.approvalReason = null;
    }

    if (!this.executor) {
      // 状態遷移のみ（executor 未指定時の従来挙動）。
      step.status = '完了';
      this.recordCompletion(request, step);
      return this.commit(request);
    }

    // 実行前に「実行中」を保存する。中断されたら再起動時に検出して自動再実行しない。
    step.status = '実行中';
    request.status = '実行中';
    request.rollbackPoint = {
      stepIndex: step.index,
      completedSteps: request.steps.filter((item) => item.status === '完了').length,
      at: this.now().toISOString()
    };
    this.commit(request);
    this.audit(request, 'step_started', { stepIndex: step.index, tool: step.tool });

    const result = await this.executor.execute({ requestId: request.id, stepIndex: step.index, tool: step.tool });
    if (result.status === 'OK') {
      step.status = '完了';
      request.blockedReason = null;
      this.recordCompletion(request, step);
      this.audit(request, 'step_completed', { stepIndex: step.index, tool: step.tool, evidence: result.evidence });
    } else if (result.status === BLOCKED_TOOL_CONNECTION) {
      // 未実行のまま戻す。完了扱いにしない。他の依頼には影響させない。
      step.status = '未着手';
      request.status = 'BLOCKED_TOOL_CONNECTION';
      request.blockedReason = result.reason;
      this.audit(request, 'step_blocked', { stepIndex: step.index, tool: step.tool, reason: result.reason });
    } else {
      step.status = '失敗';
      request.status = '停止';
      request.stopReason = result.reason || 'step_failed';
      this.audit(request, 'step_failed', { stepIndex: step.index, tool: step.tool, reason: request.stopReason });
    }
    return this.commit(request);
  }

  recordCompletion(request, step) {
    request.checkpoint = {
      completedSteps: request.steps.filter((item) => item.status === '完了').length,
      lastCompletedTool: step.tool,
      updatedAt: this.now().toISOString()
    };
    request.status = request.steps.every((item) => item.status === '完了') ? '完了' : '実行中';
  }

  /**
   * 停止した依頼を再開可能な状態に戻す。
   * 実行中のまま中断された手順は、実行されていないことを確認したうえで（confirmNotExecuted）のみ戻す。
   */
  resume(requestId, { confirmNotExecuted = false } = {}) {
    const request = this.find(requestId);
    if (request.status !== '停止') throw requestError('停止中の依頼のみ再開できます');
    const inFlight = request.steps.filter((step) => step.status === '実行中');
    if (inFlight.length > 0 && confirmNotExecuted !== true) {
      throw requestError('中断された手順が実行されたかを確認してから再開してください（confirmNotExecuted）');
    }
    for (const step of request.steps) {
      if (step.status === '実行中' || step.status === '失敗') step.status = '未着手';
    }
    request.stopReason = null;
    request.status = request.steps.some((step) => step.approvalRequired && !step.approved && step.status === '未着手')
      ? '人間承認待ち'
      : '待機中';
    this.audit(request, 'resumed', { confirmNotExecuted: inFlight.length > 0 });
    return this.commit(request);
  }

  /**
   * 直前に開始した手順をロールバック地点として、未完了の状態に戻す。
   * 完了済みの手順の外部への影響は取り消さない。補償が必要な手順を一覧で返す（人間が判断する）。
   */
  rollback(requestId) {
    const request = this.find(requestId);
    if (!request.rollbackPoint) throw requestError('ロールバック地点がありません');
    if (!['停止', 'BLOCKED_TOOL_CONNECTION', '人間承認待ち'].includes(request.status)) {
      throw requestError('実行中・完了の依頼は停止後にロールバックしてください');
    }
    const target = request.steps[request.rollbackPoint.stepIndex];
    if (target && (target.status === '実行中' || target.status === '失敗')) target.status = '未着手';
    const externalCompensationRequired = request.steps
      .filter((step) => step.status === '完了')
      .map((step) => ({ stepIndex: step.index, tool: step.tool }));
    request.stopReason = 'rolled_back';
    request.status = '停止';
    this.audit(request, 'rolled_back', {
      toStepIndex: request.rollbackPoint.stepIndex,
      externalCompensationRequired
    });
    this.commit(request);
    return { ...this.snapshot(request), externalCompensationRequired };
  }

  /** 失敗したステップを記録し、依頼を停止する（チェックポイントは直前の成功まで）。 */
  fail(requestId, reason = 'step_failed') {
    const request = this.find(requestId);
    const step = request.steps.find((item) => item.status === '未着手');
    if (step) step.status = '失敗';
    request.status = '停止';
    request.stopReason = reason;
    this.audit(request, 'step_failed', { reason });
    return this.commit(request);
  }

  find(requestId) {
    const request = this.requests.get(requestId);
    if (!request) throw notFoundError('実行依頼が見つかりません');
    return request;
  }

  touch(request) {
    request.updatedAt = this.now().toISOString();
  }

  commit(request) {
    this.touch(request);
    this.persist(request);
    return this.snapshot(request);
  }

  persist(request) {
    if (this.store) this.store.putRequest(request);
  }

  audit(request, event, detail = {}) {
    if (!this.store) return;
    this.store.appendAudit({ requestId: request.id, event, status: request.status, detail });
  }

  snapshot(request) {
    return {
      requestId: request.id,
      agentId: request.agentId,
      priority: request.priority,
      status: request.status,
      stopReason: request.stopReason || null,
      approvalReason: request.approvalReason || null,
      blockedReason: request.blockedReason || null,
      idempotencyKey: request.idempotencyKey || null,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      steps: request.steps.map((step) => ({ ...step, dependsOn: [...(step.dependsOn || [])] })),
      checkpoint: { ...request.checkpoint },
      rollbackPoint: request.rollbackPoint ? { ...request.rollbackPoint } : null
    };
  }
}

module.exports = {
  ExecutionQueue,
  PRIORITY_ORDER,
  REQUEST_STATUSES,
  validateExecutionRequest
};
