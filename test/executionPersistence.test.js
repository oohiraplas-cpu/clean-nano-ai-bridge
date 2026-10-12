const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ExecutionQueue } = require('../src/executionQueue');
const { ExecutionStore } = require('../src/executionStore');
const { ToolExecutor, BLOCKED_TOOL_CONNECTION } = require('../src/toolExecutor');
const { validateDependencies, readySteps } = require('../src/dependencyGraph');

const AGENTS = [
  { id: 'TestAI', allowedTools: ['t1', 't2', 't3', 't4'], humanApprovalRequired: ['t3'] },
  { id: 'OtherAI', allowedTools: ['o1'], humanApprovalRequired: [] }
];

function tempStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-exec-'));
  return path.join(dir, 'execution-queue.json');
}

// 検証済みの結果を返す接続。呼び出し回数を数える。
function verifiedConnectors(calls) {
  const connector = (tool) => async ({ stepIndex }) => {
    calls.push({ tool, stepIndex });
    return { verified: true, evidence: `${tool} ok` };
  };
  return { t1: connector('t1'), t2: connector('t2'), t4: connector('t4'), o1: connector('o1') };
}

function queueWith(storePath, { connectors = {}, ledger = null } = {}) {
  return new ExecutionQueue({
    agents: AGENTS,
    store: new ExecutionStore({ filePath: storePath }),
    executor: new ToolExecutor({ connectors }),
    ledger,
    owner: 'test-owner'
  });
}

test('再起動復旧: 完了済みのチェックポイントと状態を、再起動後も復元する', async () => {
  const storePath = tempStorePath();
  const calls = [];
  const first = queueWith(storePath, { connectors: verifiedConnectors(calls) });
  const { requestId } = first.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }, { tool: 't2' }] });
  await first.advance(requestId);

  const restarted = queueWith(storePath, { connectors: verifiedConnectors(calls) });
  const status = restarted.getStatus(requestId);
  assert.equal(status.checkpoint.completedSteps, 1);
  assert.equal(status.steps[0].status, '完了');
  assert.equal(status.steps[1].status, '未着手');

  await restarted.advance(requestId);
  assert.equal(restarted.getStatus(requestId).status, '完了');
});

test('成功済みステップは再実行されない（再起動後も同じステップを二度呼ばない）', async () => {
  const storePath = tempStorePath();
  const calls = [];
  const first = queueWith(storePath, { connectors: verifiedConnectors(calls) });
  const { requestId } = first.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }, { tool: 't2' }] });
  await first.advance(requestId);

  const restarted = queueWith(storePath, { connectors: verifiedConnectors(calls) });
  await restarted.advance(requestId);
  await restarted.advance(requestId).catch(() => {});

  assert.deepEqual(calls.map((c) => c.stepIndex), [0, 1], '各ステップは1回だけ実行される');
});

test('実行中のまま中断された手順は、再起動時に自動再実行せず停止する', async () => {
  const storePath = tempStorePath();
  let release;
  const hang = new Promise((resolve) => { release = resolve; });
  const hanging = queueWith(storePath, {
    connectors: { t1: async () => { await hang; return { verified: true }; } }
  });
  const { requestId } = hanging.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }] });
  const pending = hanging.advance(requestId);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // ここでプロセス異常終了を模擬：保存済みの「実行中」状態のまま別インスタンスを起動
  const calls = [];
  const restarted = queueWith(storePath, { connectors: verifiedConnectors(calls) });
  const status = restarted.getStatus(requestId);
  assert.equal(status.status, '停止');
  assert.equal(status.stopReason, 'recovery_requires_verification');
  assert.equal(status.steps[0].status, '実行中');
  assert.deepEqual(calls, [], '復旧時に再実行しない');
  release();
  await pending.catch(() => {});
});

test('中断された手順は、確認フラグなしでは再開できない', async () => {
  const storePath = tempStorePath();
  const first = queueWith(storePath, { connectors: { t1: async () => new Promise(() => {}) } });
  const { requestId } = first.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }] });
  first.advance(requestId).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  const restarted = queueWith(storePath, { connectors: verifiedConnectors([]) });
  assert.throws(() => restarted.resume(requestId), /確認してから再開/);
  restarted.resume(requestId, { confirmNotExecuted: true });
  assert.equal(restarted.getStatus(requestId).steps[0].status, '未着手');
});

test('冪等性: 同じ idempotencyKey の依頼は再作成されず、既存の依頼を返す', () => {
  const storePath = tempStorePath();
  const queue = queueWith(storePath);
  const input = { agentId: 'TestAI', steps: [{ tool: 't1' }], idempotencyKey: 'req-key-1' };
  const a = queue.createRequest(input);
  const b = queue.createRequest(input);
  assert.equal(b.requestId, a.requestId);
  assert.equal(queue.getQueue().length, 1);

  const restarted = queueWith(storePath);
  assert.equal(restarted.createRequest(input).requestId, a.requestId, '再起動後も同じキーは同じ依頼');
  const events = restarted.getAudit(a.requestId).map((e) => e.event);
  assert.ok(events.includes('duplicate_create_ignored'));
});

test('重複実行防止: 同じ依頼への同時 advance は一方が 409 で拒否される', async () => {
  const storePath = tempStorePath();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = queueWith(storePath, {
    connectors: { t1: async () => { await gate; return { verified: true, evidence: 'ok' }; } }
  });
  const { requestId } = queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }] });
  const first = queue.advance(requestId);
  await assert.rejects(() => queue.advance(requestId), (error) => error.status === 409);
  release();
  await first;
  assert.equal(queue.getStatus(requestId).status, '完了');
});

test('実行ロック: 期限切れのロックは解除され、他プロセスの有効なロックは尊重される', () => {
  const storePath = tempStorePath();
  let nowMs = Date.parse('2026-10-12T00:00:00Z');
  const store = new ExecutionStore({ filePath: storePath, now: () => new Date(nowMs) });
  assert.equal(store.acquireLock('r1', 'owner-a', 1000), true);
  assert.equal(store.acquireLock('r1', 'owner-b', 1000), false, '有効なロックは取れない');
  nowMs += 2000;
  assert.equal(store.acquireLock('r1', 'owner-b', 1000), true, '期限切れは解除して取り直せる');
});

test('接続のないツールは BLOCKED_TOOL_CONNECTION となり、完了扱いにしない。他の依頼は継続する', async () => {
  const storePath = tempStorePath();
  const calls = [];
  // t1 は未接続、o1 は接続済み
  const queue = queueWith(storePath, { connectors: { o1: verifiedConnectors(calls).o1 } });
  const blocked = queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }] });
  const other = queue.createRequest({ agentId: 'OtherAI', steps: [{ tool: 'o1' }] });

  const blockedResult = await queue.advance(blocked.requestId);
  assert.equal(blockedResult.status, 'BLOCKED_TOOL_CONNECTION');
  assert.equal(blockedResult.steps[0].status, '未着手');
  assert.equal(blockedResult.blockedReason, 'tool_not_connected');
  assert.ok(queue.getQueue().some((r) => r.requestId === blocked.requestId), '未完了のまま待機キューに残る');

  const otherResult = await queue.advance(other.requestId);
  assert.equal(otherResult.status, '完了', '他の依頼は影響を受けない');
});

test('Result Verifier: 検証されない結果は成功扱いにしない（DONE禁止）', async () => {
  const storePath = tempStorePath();
  const queue = queueWith(storePath, {
    connectors: { t1: async () => ({ verified: false }) }
  });
  const { requestId } = queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }] });
  const result = await queue.advance(requestId);
  assert.equal(result.status, '停止');
  assert.equal(result.stopReason, 'verification_failed');
  assert.equal(result.steps[0].status, '失敗');
});

test('ツールが例外を投げても詳細を出さず、失敗として停止する', async () => {
  const storePath = tempStorePath();
  const queue = queueWith(storePath, {
    connectors: { t1: async () => { throw new Error('secret-token-xyz'); } }
  });
  const { requestId } = queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }] });
  const result = await queue.advance(requestId);
  assert.equal(result.stopReason, 'tool_error');
  assert.ok(!JSON.stringify(queue.getAudit(requestId)).includes('secret-token-xyz'), '監査にも秘密値を出さない');
});

test('監査ログ（Execution History）: 作成・開始・完了が依頼ごとに記録される', async () => {
  const storePath = tempStorePath();
  const queue = queueWith(storePath, { connectors: verifiedConnectors([]) });
  const { requestId } = queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }] });
  await queue.advance(requestId);
  const events = queue.getAudit(requestId).map((e) => e.event);
  assert.deepEqual(events, ['created', 'step_started', 'step_completed']);
  assert.equal(queue.getStatus(requestId).status, '完了');
  const completed = queue.getAudit(requestId).find((e) => e.event === 'step_completed');
  assert.equal(completed.detail.evidence, 't1 ok');
  assert.ok(completed.at, 'タイムスタンプがある');
});

test('ロールバック: 開始した手順を未完了に戻し、完了済みの補償が必要な手順を一覧で返す', async () => {
  const storePath = tempStorePath();
  const queue = queueWith(storePath, {
    connectors: { t1: async () => ({ verified: true, evidence: 'ok' }), t2: async () => ({ verified: false }) }
  });
  const { requestId } = queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }, { tool: 't2' }] });
  await queue.advance(requestId);
  const failed = await queue.advance(requestId);
  assert.equal(failed.status, '停止');

  const rolled = queue.rollback(requestId);
  assert.equal(rolled.steps[1].status, '未着手', '開始した手順は再実行できる状態に戻る');
  assert.deepEqual(rolled.externalCompensationRequired, [{ stepIndex: 0, tool: 't1' }]);
  assert.equal(rolled.stopReason, 'rolled_back');
  assert.ok(queue.getAudit(requestId).some((e) => e.event === 'rolled_back'));
});

test('ロールバック地点がない依頼はロールバックできない', () => {
  const queue = queueWith(tempStorePath());
  const { requestId } = queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1' }] });
  assert.throws(() => queue.rollback(requestId), /ロールバック地点/);
});

test('依存グラフ: 循環・範囲外・自己参照を拒否する', () => {
  const queue = queueWith(tempStorePath());
  assert.throws(
    () => queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1', dependsOn: [1] }, { tool: 't2', dependsOn: [0] }] }),
    /循環/
  );
  assert.throws(
    () => queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1', dependsOn: [5] }] }),
    /範囲外/
  );
  assert.throws(
    () => queue.createRequest({ agentId: 'TestAI', steps: [{ tool: 't1', dependsOn: [0] }] }),
    /自分自身/
  );
  assert.equal(validateDependencies([{}, { dependsOn: [0] }]), null);
});

test('依存グラフ: 依存先が完了するまで後続ステップは実行されない', async () => {
  const storePath = tempStorePath();
  const calls = [];
  const queue = queueWith(storePath, { connectors: verifiedConnectors(calls) });
  // step0 は step1 に依存しない。step1 は step2 の完了を待つ。
  const { requestId } = queue.createRequest({
    agentId: 'TestAI',
    steps: [{ tool: 't1' }, { tool: 't2', dependsOn: [0] }, { tool: 't4', dependsOn: [0] }]
  });
  await queue.advance(requestId);
  await queue.advance(requestId);
  await queue.advance(requestId);
  assert.deepEqual(calls.map((c) => c.stepIndex), [0, 1, 2]);
  assert.equal(queue.getStatus(requestId).status, '完了');
});

test('依存グラフ: readySteps は依存先が完了した未着手のステップだけを返す', () => {
  const steps = [
    { index: 0, status: '完了', dependsOn: [] },
    { index: 1, status: '未着手', dependsOn: [0] },
    { index: 2, status: '未着手', dependsOn: [1] }
  ];
  assert.deepEqual(readySteps(steps).map((s) => s.index), [1]);
});

test('保存ファイルが破損していたら、自動修復せず停止する', () => {
  const storePath = tempStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, '{ broken', 'utf8');
  assert.throws(() => new ExecutionStore({ filePath: storePath }), /破損/);
  assert.equal(fs.readFileSync(storePath, 'utf8'), '{ broken', '元のファイルを上書きしない');
});

test('ToolExecutor: 接続なしは BLOCKED_TOOL_CONNECTION を返す', async () => {
  const result = await new ToolExecutor({ connectors: {} }).execute({ requestId: 'r', stepIndex: 0, tool: 't1' });
  assert.equal(result.status, BLOCKED_TOOL_CONNECTION);
});
