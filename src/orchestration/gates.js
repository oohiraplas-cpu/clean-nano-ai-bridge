'use strict';

// 差分テスト・独立Verifier・統合Gate。
// - 実装者の自己申告（selfReport）は判定に使わない。実際のテスト結果・走査結果だけで判定する。
// - 統合は、2レーン以上をまとめる時と commit 前に、全回帰試験が PASS している場合だけ許可する。

// 変更されたソースに依存するテストだけを選ぶ（開発途中の影響範囲テスト）。
// testRequires: { '<テストファイル>': ['<モジュール名>', ...] } の形で、テストが require しているモジュールを渡す。
function selectTests(changedFiles, testRequires) {
  const changed = new Set(changedFiles.map((f) => f.replace(/\.js$/, '').replace(/^src\//, '')));
  const selected = [];
  for (const [testFile, modules] of Object.entries(testRequires)) {
    const touched = modules.some((m) => changed.has(String(m).replace(/^\.\.?\//, '').replace(/^src\//, '').replace(/\.js$/, '')));
    if (touched) selected.push(testFile);
  }
  return { selected };
}

// 実際の結果だけで判定する独立Verifier。
function testsPassing(tests) {
  if (!tests || typeof tests !== 'object' || Array.isArray(tests)) return false;
  if (!Number.isSafeInteger(tests.pass) || tests.pass <= 0 || tests.fail !== 0) return false;
  // 未実行・中断された試験を全件PASSの根拠にしない。旧形式ではこれらの件数は省略可能。
  return ['cancelled', 'skipped', 'todo'].every((key) =>
    tests[key] === undefined || (Number.isSafeInteger(tests[key]) && tests[key] === 0));
}

function independentVerify(facts) {
  const problems = [];
  if (!testsPassing(facts?.tests)) problems.push('TESTS_NOT_PASSING');
  facts = facts || {};
  if (facts.secretScan && facts.secretScan.findings > 0) problems.push('SECRET_FOUND');
  if (facts.backCompat && facts.backCompat.broken === true) problems.push('BACKWARD_COMPAT_BROKEN');
  if (facts.contract && facts.contract.violations > 0) problems.push('CONTRACT_VIOLATION');
  const verdict = problems.length === 0 ? 'PASS' : 'FAIL';
  const claimMismatch = Boolean(facts.selfReport && facts.selfReport.status === 'PASS' && verdict === 'FAIL');
  return { verdict, problems, selfReportIgnored: true, claimMismatch };
}

// 統合Gate。全回帰が必要な条件（2レーン以上、または commit 前）を満たさなければ統合しない。
function integrationGate({ lanesToIntegrate, fullRegression, commitPending = false }) {
  const needsFullRegression = lanesToIntegrate >= 2 || commitPending;
  if (needsFullRegression && !fullRegression) return { allowed: false, reasonCode: 'FULL_REGRESSION_REQUIRED' };
  if (fullRegression && !testsPassing(fullRegression)) return { allowed: false, reasonCode: 'FULL_REGRESSION_FAILED' };
  return { allowed: true, reasonCode: null };
}

// 統合失敗時は原因タスクだけを戻す（他の正常タスクは残す）。
function revertCause(failedTaskId, integratedTasks) {
  if (!integratedTasks.includes(failedTaskId)) return { revert: [], keep: [...integratedTasks] };
  return { revert: [failedTaskId], keep: integratedTasks.filter((t) => t !== failedTaskId) };
}

module.exports = { selectTests, independentVerify, integrationGate, revertCause };
