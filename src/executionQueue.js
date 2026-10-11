/**
 * Execution Queue
 *
 * エージェントへの実行依頼を受け付け、優先順位付きで管理する。
 * - 依頼は Agent Registry に登録されたエージェントと、その allowedTools の範囲に限定する。
 * - 人間承認が必要なステップは「人間承認待ち」で止め、承認なしには進めない（自動承認なし）。
 * - チェックポイントは完了したステップ数で保持し、停止後はそこから再開する。
 * - 本モジュールは実行器ではない。ツールを呼び出さず、状態遷移と記録のみを扱う（外部APIには触れない）。
 */

const crypto = require('node:crypto');
const { AGENT_DEFINITIONS } = require('./agentRegistry');

const PRIORITY_ORDER = Object.freeze({ high: 0, normal: 1, low: 2 });
const TERMINAL_STATUSES = Object.freeze(['完了', '停止']);
const REQUEST_STATUSES = Object.freeze(['待機中', '実行中', '人間承認待ち', '完了', '停止']);

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
  if (input.priority !== undefined && !(input.priority in PRIORITY_ORDER)) return 'priority は high / normal / low のいずれかです';
  return null;
}

class ExecutionQueue {
  constructor({ agents = AGENT_DEFINITIONS, now = () => new Date() } = {}) {
    this.agents = agents;
    this.now = now;
    this.requests = new Map();
    this.sequence = 0;
  }

  /** 実行依頼を登録する。承認が必要なステップを含む場合は「人間承認待ち」で開始する。 */
  createRequest(input) {
    const problem = validateExecutionRequest(input, this.agents);
    if (problem) throw requestError(problem);
    const agent = this.agents.find((item) => item.id === input.agentId);
    const id = crypto.randomUUID();
    const steps = input.steps.map((step, index) => ({
      index,
      tool: step.tool,
      approvalRequired: agent.humanApprovalRequired.includes(step.tool),
      approved: false,
      status: '未着手'
    }));
    const request = {
      id,
      agentId: agent.id,
      priority: input.priority || 'normal',
      sequence: ++this.sequence,
      status: steps.some((step) => step.approvalRequired) ? '人間承認待ち' : '待機中',
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      steps,
      checkpoint: { completedSteps: 0, lastCompletedTool: null, updatedAt: null }
    };
    this.requests.set(id, request);
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

  /**
   * 人間が承認したステップを記録する（承認は人間のみ。AIは呼び出さない）。
   * 承認後は待機中に戻り、再開可能になる。
   */
  approveStep(requestId, stepIndex, approvedByHuman) {
    if (approvedByHuman !== true) throw requestError('承認は人間による明示的な承認（approvedByHuman: true）が必要です');
    const request = this.find(requestId);
    const step = request.steps[stepIndex];
    if (!step) throw requestError('対象のstepが見つかりません');
    if (!step.approvalRequired) throw requestError('このstepは承認対象ではありません');
    step.approved = true;
    this.touch(request);
    if (request.status === '人間承認待ち' && this.nextPendingApproval(request) === null) request.status = '待機中';
    return this.snapshot(request);
  }

  /**
   * 次のステップを1件進める。承認が必要な未承認ステップに達したら「人間承認待ち」で止める。
   * 成功したステップはチェックポイントに記録する。
   */
  advance(requestId) {
    const request = this.find(requestId);
    if (TERMINAL_STATUSES.includes(request.status)) throw requestError(`終了済みの依頼です（${request.status}）`);
    const next = request.steps.find((step) => step.status === '未着手');
    if (!next) {
      request.status = '完了';
      this.touch(request);
      return this.snapshot(request);
    }
    if (next.approvalRequired && !next.approved) {
      request.status = '人間承認待ち';
      this.touch(request);
      return this.snapshot(request);
    }
    request.status = '実行中';
    next.status = '完了';
    request.checkpoint = {
      completedSteps: request.steps.filter((step) => step.status === '完了').length,
      lastCompletedTool: next.tool,
      updatedAt: this.now().toISOString()
    };
    if (request.steps.every((step) => step.status === '完了')) request.status = '完了';
    this.touch(request);
    return this.snapshot(request);
  }

  /** 停止した依頼を、チェックポイントの次のステップから再開可能な状態に戻す。 */
  resume(requestId) {
    const request = this.find(requestId);
    if (request.status !== '停止') throw requestError('停止中の依頼のみ再開できます');
    const failed = request.steps.find((step) => step.status === '失敗');
    if (failed) failed.status = '未着手';
    request.status = request.steps.some((step) => step.approvalRequired && !step.approved && step.status === '未着手')
      ? '人間承認待ち'
      : '待機中';
    this.touch(request);
    return this.snapshot(request);
  }

  /** 失敗したステップを記録し、依頼を停止する（チェックポイントは直前の成功まで）。 */
  fail(requestId, reason = 'step_failed') {
    const request = this.find(requestId);
    const step = request.steps.find((item) => item.status === '未着手');
    if (step) step.status = '失敗';
    request.status = '停止';
    request.stopReason = reason;
    this.touch(request);
    return this.snapshot(request);
  }

  find(requestId) {
    const request = this.requests.get(requestId);
    if (!request) throw notFoundError('実行依頼が見つかりません');
    return request;
  }

  nextPendingApproval(request) {
    return request.steps.find((step) => step.approvalRequired && !step.approved && step.status === '未着手') || null;
  }

  touch(request) {
    request.updatedAt = this.now().toISOString();
  }

  snapshot(request) {
    return {
      requestId: request.id,
      agentId: request.agentId,
      priority: request.priority,
      status: request.status,
      stopReason: request.stopReason || null,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      steps: request.steps.map((step) => ({ ...step })),
      checkpoint: { ...request.checkpoint }
    };
  }
}

module.exports = {
  ExecutionQueue,
  PRIORITY_ORDER,
  REQUEST_STATUSES,
  validateExecutionRequest
};
