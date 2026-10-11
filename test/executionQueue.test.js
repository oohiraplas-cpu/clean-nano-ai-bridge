const test = require('node:test');
const assert = require('node:assert/strict');
const { ExecutionQueue, validateExecutionRequest } = require('../src/executionQueue');
const { AGENT_DEFINITIONS } = require('../src/agentRegistry');
const { MCP_PUBLIC_TOOLS, MCP_METHODS } = require('../src/server');

const tick = () => {
  let t = Date.parse('2026-10-11T12:00:00Z');
  return () => new Date((t += 1000));
};

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

test('承認が必要なステップを含む依頼は「人間承認待ち」で始まり、AIだけでは進まない', () => {
  const queue = new ExecutionQueue({ now: tick() });
  const created = queue.createRequest({ agentId: 'ReleaseAI', steps: [{ tool: 'deploy_to_test' }] });
  assert.equal(created.status, '人間承認待ち');
  const advanced = queue.advance(created.requestId);
  assert.equal(advanced.status, '人間承認待ち');
  assert.equal(advanced.steps[0].status, '未着手');
});

test('承認を人間が与えると、チェックポイントを記録しながら完了まで進む', () => {
  const queue = new ExecutionQueue({ now: tick() });
  const created = queue.createRequest({ agentId: 'ReleaseAI', steps: [{ tool: 'verify_deployment' }, { tool: 'deploy_to_test' }] });
  assert.equal(created.status, '人間承認待ち');
  assert.throws(() => queue.approveStep(created.requestId, 1, false), /承認は人間/);
  queue.approveStep(created.requestId, 1, true);
  queue.advance(created.requestId);
  assert.equal(queue.getCheckpoint(created.requestId).completedSteps, 1);
  const done = queue.advance(created.requestId);
  assert.equal(done.status, '完了');
  assert.equal(queue.getCheckpoint(created.requestId).completedSteps, 2);
  assert.equal(queue.getCheckpoint(created.requestId).lastCompletedTool, 'deploy_to_test');
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

test('完了・停止した依頼はキューから外れる', () => {
  const queue = new ExecutionQueue({ now: tick() });
  const a = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }] });
  queue.advance(a.requestId);
  assert.equal(queue.getStatus(a.requestId).status, '完了');
  assert.equal(queue.getQueue().length, 0);
  assert.throws(() => queue.advance(a.requestId), /終了済み/);
});

test('停止した依頼はチェックポイントの位置から再開できる', () => {
  const queue = new ExecutionQueue({ now: tick() });
  const created = queue.createRequest({ agentId: 'CommanderAI', steps: [{ tool: 'get_tasks' }, { tool: 'get_next_task' }, { tool: 'create_task' }] });
  queue.advance(created.requestId);
  queue.fail(created.requestId, 'upstream_error');
  const stopped = queue.getStatus(created.requestId);
  assert.equal(stopped.status, '停止');
  assert.equal(stopped.stopReason, 'upstream_error');
  assert.equal(queue.getCheckpoint(created.requestId).completedSteps, 1);
  const resumed = queue.resume(created.requestId);
  assert.equal(resumed.status, '待機中');
  queue.advance(created.requestId);
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
