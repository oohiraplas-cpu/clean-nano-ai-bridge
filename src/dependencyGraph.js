/**
 * 実行ステップの依存グラフ検証
 *
 * 各ステップは任意で dependsOn（先行ステップの index の配列）を持てる。
 * - 依存先は範囲内の整数であること、自分自身を指さないこと、循環しないこと、を検証する。
 * - 実行可能なステップは「未着手」かつ、依存先がすべて「完了」のもの。
 */

/**
 * @param {Array<{dependsOn?: number[]}>} steps
 * @returns {string|null} エラーメッセージ（問題なければ null）
 */
function validateDependencies(steps) {
  for (let i = 0; i < steps.length; i += 1) {
    const deps = steps[i].dependsOn;
    if (deps === undefined) continue;
    if (!Array.isArray(deps) || deps.some((dep) => !Number.isInteger(dep))) {
      return `step ${i} の dependsOn は整数の配列で指定してください`;
    }
    for (const dep of deps) {
      if (dep < 0 || dep >= steps.length) return `step ${i} の依存先が範囲外です: ${dep}`;
      if (dep === i) return `step ${i} が自分自身に依存しています`;
    }
  }
  return hasCycle(steps) ? '依存関係に循環があります' : null;
}

function hasCycle(steps) {
  const state = new Array(steps.length).fill(0); // 0: 未訪問, 1: 探索中, 2: 完了
  const visit = (index) => {
    if (state[index] === 1) return true;
    if (state[index] === 2) return false;
    state[index] = 1;
    for (const dep of steps[index].dependsOn || []) {
      if (visit(dep)) return true;
    }
    state[index] = 2;
    return false;
  };
  return steps.some((_, index) => visit(index));
}

/**
 * 実行可能なステップ（未着手で、依存先がすべて完了）を、index の昇順で返す。
 * @param {Array<{index: number, status: string, dependsOn?: number[]}>} steps - index は配列内の位置と一致すること
 */
function readySteps(steps) {
  return steps.filter(
    (step) => step.status === '未着手' && (step.dependsOn || []).every((dep) => steps[dep].status === '完了')
  );
}

module.exports = { validateDependencies, readySteps };
