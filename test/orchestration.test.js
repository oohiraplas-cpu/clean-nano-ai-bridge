'use strict';
// 効率化基盤: DAG実行、チェックポイント、BLOCKED一括処理、自動再開、差分テスト・独立Verifier・統合Gate。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTaskGraph } = require('../src/orchestration/taskGraph');
const { buildCheckpoint, validateCheckpoint, saveCheckpoint, restoreCheckpoint, collectBlocked, humanActionBundle, autoResume } = require('../src/orchestration/checkpoint');
const { selectTests, independentVerify, integrationGate, revertCause } = require('../src/orchestration/gates');

// ---------- DAG ----------

test('a task starts only after all of its dependencies have completed', () => {
  const g = createTaskGraph([{ id: 'a' }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['a', 'b'] }]);
  assert.deepEqual(g.startReady(), ['a']);
  assert.deepEqual(g.complete('a'), ['b']);
  assert.deepEqual(g.startReady(), ['b']);
  g.complete('b');
  assert.deepEqual(g.readyTasks(), ['c']);
});

test('an independent task is started immediately without waiting for an unrelated wave', () => {
  const g = createTaskGraph([{ id: 'slow' }, { id: 'fast' }, { id: 'after-fast', deps: ['fast'] }]);
  assert.deepEqual(g.startReady().sort(), ['fast', 'slow']);
  g.complete('fast');
  assert.deepEqual(g.startReady(), ['after-fast'], 'dependent starts while slow is still running');
});

test('tasks touching the same file never run at the same time', () => {
  const g = createTaskGraph([{ id: 'x', files: ['src/a.js'] }, { id: 'y', files: ['src/a.js'] }, { id: 'z', files: ['src/b.js'] }]);
  const started = g.startReady();
  assert.ok(started.includes('x') && started.includes('z'));
  assert.equal(started.includes('y'), false);
  g.complete('x');
  assert.deepEqual(g.startReady(), ['y']);
});

test('the parallel limit is respected', () => {
  const g = createTaskGraph([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }], { maxParallel: 2 });
  assert.equal(g.startReady().length, 2);
  assert.equal(g.startReady().length, 0, 'no free slot');
  g.complete('1');
  assert.equal(g.startReady().length, 1);
});

test('a failed task isolates only its dependents; unrelated tasks continue', () => {
  const g = createTaskGraph([{ id: 'bad' }, { id: 'child', deps: ['bad'] }, { id: 'grandchild', deps: ['child'] }, { id: 'ok' }]);
  g.startReady();
  const outcome = g.fail('bad', 'TEST_FAILED');
  assert.deepEqual(outcome.isolated.sort(), ['child', 'grandchild']);
  assert.equal(g.get('ok').state, 'running');
  g.complete('ok');
  assert.equal(g.get('ok').state, 'completed');
});

test('a blocked task holds its dependents without counting as a failure', () => {
  const g = createTaskGraph([{ id: 'needs-human' }, { id: 'dep', deps: ['needs-human'] }, { id: 'independent' }]);
  g.startReady();
  g.block('needs-human', 'OIDC_NOT_CONFIGURED', 'federated credential を設定する');
  assert.equal(g.get('dep').state, 'pending');
  assert.equal(g.get('independent').state, 'running');
  assert.equal(g.summary().failed, 0);
  g.unblock('needs-human');
  assert.equal(g.get('needs-human').state, 'pending');
});

test('a critical safety failure stops only the tasks of the same system', () => {
  const g = createTaskGraph([{ id: 'sp-1', system: 'sharepoint' }, { id: 'sp-2', system: 'sharepoint' }, { id: 'pp-1', system: 'powerplatform' }]);
  const stopped = g.stopSystem('sharepoint', 'SECRET_FOUND');
  assert.deepEqual(stopped.sort(), ['sp-1', 'sp-2']);
  assert.equal(g.get('pp-1').state, 'pending');
});

test('the graph rejects cycles, unknown dependencies and duplicate ids', () => {
  assert.throws(() => createTaskGraph([{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }]), /cycle/);
  assert.throws(() => createTaskGraph([{ id: 'a', deps: ['nope'] }]), /unknown dependency/);
  assert.throws(() => createTaskGraph([{ id: 'a' }, { id: 'a' }]), /duplicate/);
});

test('the state is exported as machine-readable JSON', () => {
  const g = createTaskGraph([{ id: 'a' }]);
  const json = JSON.parse(JSON.stringify(g.toJSON()));
  assert.equal(json.schema, 'clean-nano-task-graph/1');
  assert.equal(json.counts.pending, 1);
  assert.equal(json.tasks[0].id, 'a');
});

// ---------- チェックポイント・BLOCKED・自動再開 ----------

function fullCheckpoint(overrides = {}) {
  return buildCheckpoint({
    goal: 'Operations MCP 100%',
    completedTasks: ['lane-a'], runningTasks: [], readyTasks: ['lane-e'], blockedTasks: ['lane-f-oidc'],
    lastGoodCommit: 'abccf2d', testStatus: '1826 PASS', ciStatus: 'success',
    requiredHumanActions: ['federated-credential'], timestamp: '2026-11-07T00:00:00.000Z', ...overrides
  });
}

test('a checkpoint carries every required field and survives a save and restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const file = path.join(dir, 'checkpoint.json');
  saveCheckpoint(file, fullCheckpoint());
  const restored = restoreCheckpoint(file);
  assert.equal(restored.ok, true);
  assert.equal(restored.checkpoint.lastGoodCommit, 'abccf2d');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a checkpoint missing a required field is refused on save and on restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const file = path.join(dir, 'checkpoint.json');
  const broken = { ...fullCheckpoint(), ciStatus: undefined };
  assert.deepEqual(validateCheckpoint(broken).missing, ['ciStatus']);
  assert.throws(() => saveCheckpoint(file, broken), /missing fields/);
  fs.writeFileSync(file, JSON.stringify({ goal: 'x' }));
  assert.equal(restoreCheckpoint(file).reasonCode, 'CHECKPOINT_INCOMPLETE');
  fs.writeFileSync(file, '{not json');
  assert.equal(restoreCheckpoint(file).reasonCode, 'CHECKPOINT_INVALID_JSON');
  assert.equal(restoreCheckpoint(path.join(dir, 'none.json')).reasonCode, 'CHECKPOINT_NOT_FOUND');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate human actions from several tasks collapse into one step with all sources listed', () => {
  const blocked = [
    { taskId: 'f-1', reasonCode: 'OIDC_NOT_CONFIGURED', actionKey: 'federated-credential', action: 'OIDC を設定' },
    { taskId: 'f-2', reasonCode: 'OIDC_NOT_CONFIGURED', actionKey: 'federated-credential', action: 'OIDC を設定' },
    { taskId: 'c-1', reasonCode: 'ADAPTER_NOT_CONFIGURED', actionKey: 'graph-consent', action: 'Sites.Selected を付与' }
  ];
  const bundle = humanActionBundle(blocked);
  assert.equal(bundle.count, 2);
  assert.deepEqual(bundle.actions[0].sourceTasks, ['f-1', 'f-2']);
});

test('malformed checkpoint fields are rejected before saving or resuming', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-invalid-'));
  const file = path.join(dir, 'checkpoint.json');
  const mutations = [
    ['schema', 'unknown/2'], ['goal', ''], ['goal', {}], ['timestamp', 0], ['timestamp', 'invalid-date'],
    ['lastGoodCommit', {}], ['testStatus', false], ['ciStatus', []],
    ...['completedTasks', 'runningTasks', 'readyTasks', 'blockedTasks', 'requiredHumanActions', 'criticalPath', 'deferredTasks', 'nextAutoTasks']
      .flatMap((field) => [[field, 'task'], [field, [42]], [field, ['']]]),
    ...[null, [], {}, { code: '50', live: 0 }, { code: NaN, live: 0 }, { code: Infinity, live: 0 }, { code: -1, live: 0 }, { code: 0, live: 101 }]
      .map((value) => ['completionPercent', value])
  ];
  try {
    for (const [field, value] of mutations) {
      const broken = { ...fullCheckpoint(), [field]: value };
      const validation = validateCheckpoint(broken);
      assert.equal(validation.ok, false, field);
      assert.ok(validation.invalid.includes(field), field);
      assert.throws(() => saveCheckpoint(file, broken), /invalid fields/);
      fs.writeFileSync(file, JSON.stringify(broken));
      const restored = restoreCheckpoint(file);
      assert.equal(restored.ok, false, field);
      assert.equal(restored.reasonCode, 'CHECKPOINT_INVALID_FIELDS');
      assert.equal(restored.checkpoint, null);
    }
    assert.equal(validateCheckpoint([]).ok, false);
    assert.equal(validateCheckpoint(fullCheckpoint({ lastGoodCommit: 'abc', completionPercent: { code: 100, live: 0 } })).ok, true);
    assert.equal(validateCheckpoint(require('../docs/orchestration/checkpoint.json')).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-resume returns only the tasks whose human action has been completed', () => {
  const blocked = [
    { taskId: 'f-1', actionKey: 'federated-credential' },
    { taskId: 'c-1', actionKey: 'graph-consent' }
  ];
  const result = autoResume(blocked, ['federated-credential']);
  assert.deepEqual(result.resumed, ['f-1']);
  assert.deepEqual(result.remaining.map((r) => r.taskId), ['c-1']);
  assert.equal(collectBlocked(blocked).length, 2);
});

// ---------- 差分テスト・独立Verifier・統合Gate ----------

test('selective testing picks only the tests that require a changed module', () => {
  const requires = {
    'test/a.test.js': ['../src/operationsMcp'],
    'test/b.test.js': ['../src/server'],
    'test/c.test.js': ['../src/operations/store']
  };
  const result = selectTests(['src/operations/store.js'], requires);
  assert.deepEqual(result.selected, ['test/c.test.js']);
});

test('the independent verifier decides from raw facts and ignores a PASS self-report', () => {
  const v = independentVerify({
    tests: { pass: 100, fail: 2 },
    secretScan: { findings: 0 },
    backCompat: { broken: false },
    contract: { violations: 0 },
    selfReport: { status: 'PASS' }
  });
  assert.equal(v.verdict, 'FAIL');
  assert.deepEqual(v.problems, ['TESTS_NOT_PASSING']);
  assert.equal(v.claimMismatch, true);
});

test('the independent verifier flags secrets, broken compatibility and contract violations', () => {
  const v = independentVerify({ tests: { pass: 5, fail: 0 }, secretScan: { findings: 1 }, backCompat: { broken: true }, contract: { violations: 2 } });
  assert.equal(v.verdict, 'FAIL');
  assert.deepEqual(v.problems.sort(), ['BACKWARD_COMPAT_BROKEN', 'CONTRACT_VIOLATION', 'SECRET_FOUND']);
});

test('verification and commit gates reject missing, malformed and incomplete test results', () => {
  const invalid = [
    null, [], {}, { fail: 0 }, { pass: 1 },
    ...[undefined, null, '1', 'yes', NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]
      .map((pass) => ({ pass, fail: 0 })),
    ...[undefined, null, '0', NaN, Infinity, -1, 1, 0.5]
      .map((fail) => ({ pass: 1, fail })),
    ...['cancelled', 'skipped', 'todo'].flatMap((key) =>
      [null, '0', NaN, Infinity, -1, 1, 0.5].map((count) => ({ pass: 1, fail: 0, [key]: count })))
  ];
  for (const tests of invalid) {
    assert.equal(independentVerify({ tests }).verdict, 'FAIL');
    assert.equal(integrationGate({ commitPending: true, fullRegression: tests }).allowed, false);
  }
  assert.equal(independentVerify().verdict, 'FAIL');
  assert.equal(independentVerify(null).verdict, 'FAIL');
});

test('verification and commit gates accept complete numeric results and the existing result format', () => {
  for (const tests of [{ pass: 1, fail: 0 }, { pass: 25, fail: 0, cancelled: 0, skipped: 0, todo: 0 }]) {
    assert.equal(independentVerify({ tests }).verdict, 'PASS');
    assert.equal(integrationGate({ commitPending: true, fullRegression: tests }).allowed, true);
  }
});

test('integration needs a full regression for two or more lanes, and for every commit', () => {
  assert.equal(integrationGate({ lanesToIntegrate: 1, fullRegression: null }).allowed, true);
  assert.equal(integrationGate({ lanesToIntegrate: 2, fullRegression: null }).reasonCode, 'FULL_REGRESSION_REQUIRED');
  assert.equal(integrationGate({ lanesToIntegrate: 1, commitPending: true, fullRegression: null }).reasonCode, 'FULL_REGRESSION_REQUIRED');
  assert.equal(integrationGate({ lanesToIntegrate: 2, fullRegression: { pass: 1826, fail: 1 } }).reasonCode, 'FULL_REGRESSION_FAILED');
  assert.equal(integrationGate({ lanesToIntegrate: 2, fullRegression: { pass: 1826, fail: 0 } }).allowed, true);
});

test('a failed integration reverts only the cause task', () => {
  const r = revertCause('lane-d', ['lane-a', 'lane-d', 'lane-f']);
  assert.deepEqual(r.revert, ['lane-d']);
  assert.deepEqual(r.keep, ['lane-a', 'lane-f']);
  assert.deepEqual(revertCause('lane-x', ['lane-a']).revert, []);
});
