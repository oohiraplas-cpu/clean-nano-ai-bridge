const test = require('node:test');
const assert = require('node:assert/strict');
const { ExecutionQueue, validateExecutionRequest } = require('../src/executionQueue');
const { ApprovalLedger } = require('../src/approvalLedger');
const { AGENT_DEFINITIONS } = require('../src/agentRegistry');
const { MCP_PUBLIC_TOOLS, MCP_METHODS } = require('../src/server');

const tick = () => {
  let t = Date.parse('2026-10-11T12:00:00Z');
  return () => new Date((t += 1000));
};

const FIELD_MAP = Object.freeze({
  requestId: 'col_request', stepIndex: 'col_step', tool: 'col_tool', status: 'col_status',
  approver: 'col_approver', approvedAt: 'col_approved_at', revoked: 'col_revoked'
});

/** テスト用：承認台帳の行を注入できる ApprovalLedger を作る。 */
function ledgerWith(rows, now = () => new Date('2026-10-11T12:00:00Z')) {
  return new ApprovalLedger({
    config: { siteId: 's', listId: 'l', fieldMap: FIELD_MAP },
    fetchRows: async () => rows,
    now
  });
}

function approvalRow(overrides = {}) {
  return {
    col_request: overrides.requestId,
    col_step: overrides.stepIndex ?? 1,
    col_tool: overrides.tool ?? 'deploy_to_test',
    col_status: '承認',
    col_approver: 'approver@example.com',
    col_approved_at: '2026-10-11T11:00:00Z',
    col_revoked: false,
    ...overrides.extra
  };
}

test('未登録エージェントと許可されていないツールは拒否される', () => {
  assert.match(validateExecutionRequest({ agentId: 'NoSuchAI', steps: [{ tool: 'get_tasks' }] }), /未登録/);
  assert.match(validateExecutionRequest({ agentId: 'ProfitAI', steps: [{ tool: 'deploy_to_test' }] }), /使用できません/);
  assert.match(validateExecutionRequest({ agentId: 'CommanderAI', steps: [] }), /1件以上/);
  assert.match(validateExecutionRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }], priority: 'urgent' }), /priority/);
  assert.equal(validateExecutionRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }] }), null);
});

test('全11エージェントが実行キューでも登録されている', () => {
  assert.equal(AGENT_DEFINITIONS.length, 11);
  const queue = new ExecutionQueue({ now: tick() });
  for (const agent of AGENT_DEFINITIONS) {
    const created = queue.createRequest({ agentId: agent.id, steps: [{ tool: agent.allowedTools[0] }] });
    assert.equal(created.agentId, agent.id);
  }
});

test('フラグによる承認（approveStep）は存在しない', () => {
  const queue = new ExecutionQueue({ now: tick() });
  assert.equal(typeof queue.approveStep, 'undefined');
});

test('承認が必要な依頼は「人間承認待ち」で始まり、承認台帳がなければ進まない（fail closed）', async () => {
  const queue = new ExecutionQueue({ now: tick() });
  const created = queue.createRequest({ agentId: 'ReleaseAI', steps: [{ tool: 'deploy_to_test' }] });
  assert.equal(created.status, '人間承認待ち');
  const advanced = await queue.advance(created.requestId);
  assert.equal(advanced.status, '人間承認待ち');
  assert.equal(advanced.approvalReason, 'ledger_not_configured');
  assert.equal(advanced.steps[0].status, '未着手');
});

test('承認台帳に有効な承認があれば、チェックポイントを記録しながら完了まで進む', async () => {
  const queue = new ExecutionQueue({ now: tick() });
  const created = queue.createRequest({ agentId: 'ReleaseAI', steps: [{ tool: 'verify_deployment' }, { tool: 'deploy_to_test' }] });
  const id = created.requestId;
  queue.ledger = ledgerWith([approvalRow({ requestId: id, stepIndex: 1, tool: 'deploy_to_test' })]);
  await queue.advance(id);
  assert.equal(queue.getCheckpoint(id).completedSteps, 1);
  const done = await queue.advance(id);
  assert.equal(done.status, '完了');
  assert.equal(queue.getCheckpoint(id).completedSteps, 2);
  assert.equal(queue.getCheckpoint(id).lastCompletedTool, 'deploy_to_test');
});

test('承認台帳の承認が不正なら進まない（依頼ID・ツール・ステップ・状態・取消・期限・承認者）', async () => {
  const cases = [
    ['依頼IDが違う', { requestId: 'other' }, 'request_mismatch'],
    ['ツールが違う', { tool: 'publish_powerapps_app' }, 'tool_mismatch'],
    ['ステップが違う', { stepIndex: 1 }, 'step_mismatch'],
    ['承認ではない', { extra: { col_status: '保留' } }, 'not_approved'],
    ['取消済み', { extra: { col_revoked: true } }, 'revoked'],
    ['承認者が空', { extra: { col_approver: '' } }, 'approver_missing'],
    ['期限切れ', { extra: { col_approved_at: '2026-10-09T00:00:00Z' } }, 'approval_expired'],
    ['承認日時が未来', { extra: { col_approved_at: '2026-10-12T00:00:00Z' } }, 'approved_at_in_future']
  ];
  for (const [label, overrides, reason] of cases) {
    const queue = new ExecutionQueue({ now: tick() });
    const created = queue.createRequest({ agentId: 'ReleaseAI', steps: [{ tool: 'deploy_to_test' }] });
    const rid = created.requestId;
    const base = { requestId: rid, stepIndex: 0, tool: 'deploy_to_test', ...overrides };
    queue.ledger = ledgerWith([approvalRow(base)]);
    const result = await queue.advance(rid);
    assert.equal(result.status, '人間承認待ち', label);
    assert.equal(result.approvalReason, reason, label);
    assert.equal(result.steps[0].status, '未着手', label);
  }
});

test('承認台帳の読み取りに失敗したら、承認なしとして止まる', async () => {
  const queue = new ExecutionQueue({ now: tick() });
  const created = queue.createRequest({ agentId: 'ReleaseAI', steps: [{ tool: 'deploy_to_test' }] });
  queue.ledger = new ApprovalLedger({
    config: { siteId: 's', listId: 'l', fieldMap: FIELD_MAP },
    fetchRows: async () => { throw new Error('upstream down'); },
    now: () => new Date('2026-10-11T12:00:00Z')
  });
  const result = await queue.advance(created.requestId);
  assert.equal(result.status, '人間承認待ち');
  assert.equal(result.approvalReason, 'ledger_unreadable');
});

test('優先順位は high → normal → low、同じ優先度では登録順で並ぶ', () => {
  const queue = new ExecutionQueue({ now: tick() });
  const low = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }], priority: 'low' });
  const normal1 = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }] });
  const high = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }], priority: 'high' });
  const normal2 = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }] });
  const order = queue.getQueue().map((item) => item.requestId);
  assert.deepEqual(order, [high.requestId, normal1.requestId, normal2.requestId, low.requestId]);
  assert.deepEqual(queue.getQueue().map((item) => item.position), [1, 2, 3, 4]);
});

test('完了・停止した依頼はキューから外れる', async () => {
  const queue = new ExecutionQueue({ now: tick() });
  const a = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }] });
  await queue.advance(a.requestId);
  assert.equal(queue.getStatus(a.requestId).status, '完了');
  assert.equal(queue.getQueue().length, 0);
  await assert.rejects(() => queue.advance(a.requestId), /終了済み/);
});

test('停止した依頼はチェックポイントの位置から再開できる', async () => {
  const queue = new ExecutionQueue({ now: tick() });
  const created = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }, { tool: 'get_next_task' }, { tool: 'create_task' }] });
  await queue.advance(created.requestId);
  queue.fail(created.requestId, 'upstream_error');
  const stopped = queue.getStatus(created.requestId);
  assert.equal(stopped.status, '停止');
  assert.equal(stopped.stopReason, 'upstream_error');
  assert.equal(queue.getCheckpoint(created.requestId).completedSteps, 1);
  const resumed = queue.resume(created.requestId);
  assert.equal(resumed.status, '待機中');
  await queue.advance(created.requestId);
  assert.equal(queue.getCheckpoint(created.requestId).completedSteps, 2, '1件目の成功を再実行せず続きから進む');
});

test('停止していない依頼は再開できない', () => {
  const queue = new ExecutionQueue({ now: tick() });
  const created = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }] });
  assert.throws(() => queue.resume(created.requestId), /停止中/);
});

test('存在しない依頼IDは404相当になる', () => {
  const queue = new ExecutionQueue({ now: tick() });
  assert.throws(() => queue.getStatus('missing'), (error) => error.status === 404);
  assert.throws(() => queue.getCheckpoint('missing'), (error) => error.status === 404);
});

test('新しい4メソッドは MCP_METHODS と MCP_PUBLIC_TOOLS に登録され、読み取り系は読み取り専用', () => {
  for (const name of ['create_execution_request', 'get_execution_queue', 'get_execution_status', 'get_checkpoint']) {
    assert.ok(MCP_METHODS.includes(name), name);
    assert.ok(MCP_PUBLIC_TOOLS.some((tool) => tool.name === name), name);
  }
  for (const name of ['get_execution_queue', 'get_execution_status', 'get_checkpoint']) {
    assert.equal(MCP_PUBLIC_TOOLS.find((tool) => tool.name === name).annotations.readOnlyHint, true, name);
  }
});

test('MCP公開面に承認を操作するツールは存在しない（承認は台帳でのみ確認）', () => {
  const names = MCP_PUBLIC_TOOLS.map((tool) => tool.name);
  assert.ok(!names.some((name) => /approve|approval/i.test(name)), names.join(','));
  for (const name of ['create_execution_request', 'get_execution_queue', 'get_execution_status', 'get_checkpoint']) {
    const tool = MCP_PUBLIC_TOOLS.find((entry) => entry.name === name);
    assert.ok(!JSON.stringify(tool.inputSchema).includes('approvedByHuman'), `${name} は承認フラグを受け付けない`);
  }
});
