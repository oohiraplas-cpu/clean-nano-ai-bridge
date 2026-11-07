'use strict';

// 残作業のDAG定義（Lane 4）。
// - 必須13タスク（添付指示の一覧）＋クリティカルパス上の補助タスクを定義する。
// - 状態は「コード上の完了（証跡ファイルの存在）」と「実環境での検証（liveStatus）」を分けて扱う。
//   証跡ファイルがあるだけで実環境の検証済みにはしない。
// - 人間操作が必要なものは humanGate に理由と必要操作を書き、BLOCKED として一括提示する。

const fs = require('node:fs');
const path = require('node:path');

const CODE_STATUSES = Object.freeze(['COMPLETE', 'READY', 'PENDING', 'RUNNING', 'BLOCKED', 'DEFERRED']);
const LIVE_STATUSES = Object.freeze(['NOT_VERIFIED', 'VERIFIED', 'BLOCKED']);

// 各タスクの定義。weight は クリティカルパス計算と完了率の重み（大きいほど重要・時間がかかる）。
const REMAINING_TASKS = Object.freeze([
  {
    id: 'DAG_EXECUTOR', lane: 'lane4', goal: 'DAG実行・チェックポイント・BLOCKED一括化の実行器を用意する',
    deps: [], weight: 2, estimatedEffort: 'S', requiredCapabilities: ['node'],
    affectedFiles: ['src/orchestration/remainingWork.js', 'src/orchestration/executor.js', 'scripts/orchestrate.js'],
    evidenceFiles: ['src/orchestration/remainingWork.js', 'src/orchestration/executor.js', 'scripts/orchestrate.js'],
    selectiveTests: ['test/orchestrationDag.test.js'], fullRegressionRequired: false, rollbackAvailable: true,
    humanGate: null, additionalCost: 'なし', system: 'orchestration'
  },
  {
    id: 'FILES_ZIP_FACADE', lane: 'lane1', goal: 'Files/ZIP/構造化データを file_op・zip_op・structured_data_op で公開する',
    deps: [], weight: 4, estimatedEffort: 'L', requiredCapabilities: ['node'],
    affectedFiles: ['src/files/fileOps.js', 'src/files/zipOps.js', 'src/files/structuredData.js', 'src/files/zipSafe.js', 'src/toolVisibility.js'],
    evidenceFiles: ['src/files/fileOps.js', 'src/files/zipOps.js', 'src/files/structuredData.js', 'src/files/zipSafe.js', 'test/filesOpsFacade.test.js'],
    selectiveTests: ['test/filesOpsFacade.test.js', 'test/filesZip.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    humanGate: null, additionalCost: 'なし', system: 'files', liveStatus: 'NOT_VERIFIED'
  },
  {
    id: 'ENTRA_READ', lane: 'lane2', goal: 'Entra ID 参照（entra_read・10操作）を共通Graphクライアントで実装する',
    deps: ['DAG_EXECUTOR'], weight: 6, estimatedEffort: 'L', requiredCapabilities: ['node', 'graph-mock'],
    affectedFiles: ['src/graph/graphClient.js', 'src/operations/entraAdapter.js'],
    evidenceFiles: ['src/graph/graphClient.js', 'src/operations/entraAdapter.js', 'test/entraPowerPlatform.test.js'],
    selectiveTests: ['test/entraPowerPlatform.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    humanGate: { reasonCode: 'ENTRA_LIVE_PERMISSION', action: 'Graph アプリに必要な Application 権限を付与し管理者同意を得る（実環境の検証用）' },
    additionalCost: 'なし', system: 'entra', liveStatus: 'BLOCKED'
  },
  {
    id: 'ENTRA_WRITE', lane: 'lane2', goal: 'Entra ID 更新（entra_write・7操作）を承認ゲート・検証・ロールバック付きで実装する',
    deps: ['ENTRA_READ'], weight: 6, estimatedEffort: 'L', requiredCapabilities: ['node', 'graph-mock'],
    affectedFiles: ['src/operations/entraWrite.js'],
    evidenceFiles: ['src/operations/entraWrite.js', 'test/entraPowerPlatform.test.js'],
    selectiveTests: ['test/entraPowerPlatform.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    humanGate: { reasonCode: 'ENTRA_WRITE_APPROVAL', action: '書込み対象ごとの明示承認（approvedByHuman）の運用を決める。実書込みは行わない' },
    additionalCost: 'なし', system: 'entra', liveStatus: 'BLOCKED'
  },
  {
    id: 'POWER_PLATFORM_READ', lane: 'lane3', goal: 'Power Platform 参照（power_platform_read・9操作）を対象環境に固定して実装する',
    deps: ['DAG_EXECUTOR'], weight: 4, estimatedEffort: 'M', requiredCapabilities: ['node', 'graph-mock'],
    affectedFiles: ['src/operations/powerPlatformAdapter.js'],
    evidenceFiles: ['src/operations/powerPlatformAdapter.js', 'test/entraPowerPlatform.test.js'],
    selectiveTests: ['test/entraPowerPlatform.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    humanGate: { reasonCode: 'POWER_PLATFORM_LIVE_TOKEN', action: 'Power Platform 管理API を呼べるトークン取得経路（Managed Identity 等）を用意する' },
    additionalCost: 'なし', system: 'powerplatform', liveStatus: 'BLOCKED'
  },
  {
    id: 'POWER_AUTOMATE_READ', lane: 'lane3', goal: 'Power Automate のフロー参照（一覧・定義・接続参照・検証）を実装する',
    deps: ['POWER_PLATFORM_READ'], weight: 4, estimatedEffort: 'M', requiredCapabilities: ['node', 'graph-mock'],
    affectedFiles: ['src/operations/powerAutomateAdapter.js'],
    evidenceFiles: ['src/operations/powerAutomateAdapter.js', 'test/powerAutomateAdapter.test.js'],
    selectiveTests: ['test/powerAutomateAdapter.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    humanGate: { reasonCode: 'POWER_AUTOMATE_LIVE_READ', action: 'Dataverse（対象環境）へのフロー参照権限を持つ接続を用意する（実環境の検証用）' },
    additionalCost: 'なし', system: 'powerplatform', liveStatus: 'BLOCKED'
  },
  {
    id: 'POWER_AUTOMATE_WRITE', lane: 'lane3', goal: 'Power Automate の変更を snapshot・検証・ロールバック境界の内側でのみ行う',
    deps: ['POWER_AUTOMATE_READ', 'PERSISTENT_STORE'], weight: 5, estimatedEffort: 'L', requiredCapabilities: ['node', 'persistent-store'],
    affectedFiles: ['src/operations/powerAutomateAdapter.js'],
    evidenceFiles: ['src/operations/powerAutomateWrite.js', 'test/powerAutomateWrite.test.js'],
    selectiveTests: ['test/powerAutomateWrite.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    humanGate: { reasonCode: 'POWER_AUTOMATE_LIVE_APPROVAL', action: 'フローの有効化・変更の実施承認（本番影響の判断）' },
    additionalCost: 'なし', system: 'powerplatform', liveStatus: 'BLOCKED'
  },
  {
    id: 'EMPLOYEE_REGISTRATION_E2E', lane: 'lane4', goal: 'CN_社員新規登録_Forms取込 の E2E（モック）を定義し、実環境の実行を分ける',
    deps: ['ENTRA_WRITE', 'POWER_AUTOMATE_WRITE'], weight: 5, estimatedEffort: 'M', requiredCapabilities: ['node', 'graph-mock'],
    affectedFiles: ['test/employeeRegistrationE2E.test.js'],
    evidenceFiles: ['test/employeeRegistrationE2E.test.js'],
    selectiveTests: ['test/employeeRegistrationE2E.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    blockedByHuman: true,
    humanGate: { reasonCode: 'FLOW_DEFINITION_NOT_IN_REPO', action: '対象フロー（CN_社員新規登録_Forms取込）の定義を環境から読取り専用で取得する（flow_definition_get の実環境実行、または pac による export）。取得後にモックE2Eを作成する' },
    additionalCost: 'なし', system: 'employee', liveStatus: 'BLOCKED'
  },
  {
    id: 'SHAREPOINT_LIVE_READ', lane: 'lane4', goal: 'SharePoint の実環境読取り（サイト・リスト・添付の参照）を確認する',
    deps: [], weight: 3, estimatedEffort: 'S', requiredCapabilities: ['graph-live'],
    affectedFiles: ['src/operations/sharePointGraphAdapter.js'],
    evidenceFiles: ['src/operations/sharePointGraphAdapter.js'],
    selectiveTests: ['test/sharePointGraphAdapter.test.js'], fullRegressionRequired: false, rollbackAvailable: true,
    humanGate: { reasonCode: 'SHAREPOINT_LIVE_PERMISSION', action: 'Graph の Sites.Read.All 相当の権限と対象サイトの同意' },
    additionalCost: 'なし', system: 'sharepoint', liveStatus: 'BLOCKED'
  },
  {
    id: 'SHAREPOINT_LIVE_WRITE', lane: 'lane4', goal: 'SharePoint 書込み（保護付き）を実環境で確認する',
    deps: ['SHAREPOINT_LIVE_READ', 'PERSISTENT_STORE'], weight: 3, estimatedEffort: 'M', requiredCapabilities: ['graph-live', 'persistent-store'],
    affectedFiles: ['src/operations/sharePointGraphAdapter.js'],
    evidenceFiles: ['test/sharePointWrite.test.js'],
    selectiveTests: ['test/sharePointWrite.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    humanGate: { reasonCode: 'SHAREPOINT_LIVE_WRITE_APPROVAL', action: '対象リストへの書込み承認と、テスト用項目の指定' },
    additionalCost: 'なし', system: 'sharepoint', liveStatus: 'BLOCKED'
  },
  {
    id: 'PERSISTENT_STORE', lane: 'lane4', goal: '永続ストア（Azure Storage → SharePoint監査 → ファイル）の自動選択を実装する',
    deps: [], weight: 4, estimatedEffort: 'M', requiredCapabilities: ['node'],
    affectedFiles: ['src/persistence/storeSelect.js'],
    evidenceFiles: ['src/persistence/storeSelect.js', 'test/persistentStore.test.js'],
    selectiveTests: ['test/persistentStore.test.js'], fullRegressionRequired: true, rollbackAvailable: true,
    humanGate: { reasonCode: 'PERSISTENT_STORE_LIVE_CONNECTION', action: 'Azure Storage または SharePoint 監査リストへの接続情報（ID基盤の権限）を用意する' },
    additionalCost: 'なし', system: 'store', liveStatus: 'BLOCKED'
  },
  {
    id: 'WEBHOOK_MIGRATION', lane: 'lane4', goal: 'Webhook 呼出元の調査と compat→enforce の runbook を用意する（本番切替はしない）',
    deps: [], weight: 2, estimatedEffort: 'S', requiredCapabilities: ['docs'],
    affectedFiles: ['docs/webhook-caller-survey.md', 'docs/webhook-auth-migration.md'],
    evidenceFiles: ['docs/webhook-caller-survey.md', 'docs/webhook-auth-migration.md'],
    selectiveTests: ['test/webhookAuthMigration.test.js'], fullRegressionRequired: false, rollbackAvailable: true,
    humanGate: { reasonCode: 'WEBHOOK_CALLER_LIST', action: '本番の呼出元（Power Automate・Copilot Studio・Claude Code）の一覧を利用者が確認する' },
    additionalCost: 'なし', system: 'webhook', liveStatus: 'BLOCKED'
  },
  {
    id: 'KEY_ROTATION_RUNBOOK', lane: 'lane4', goal: 'キーローテーションの runbook と更新対象の一覧を用意する（実失効はしない）',
    deps: ['WEBHOOK_MIGRATION'], weight: 2, estimatedEffort: 'S', requiredCapabilities: ['docs'],
    affectedFiles: ['docs/key-rotation-runbook.md', 'docs/mcp-key-rotation.md'],
    evidenceFiles: ['docs/key-rotation-runbook.md', 'docs/mcp-key-rotation.md'],
    selectiveTests: [], fullRegressionRequired: false, rollbackAvailable: true,
    humanGate: { reasonCode: 'KEY_REVOCATION_APPROVAL', action: '旧キーの失効は利用ゼロの確認後に、人間が承認して行う' },
    additionalCost: 'なし', system: 'secrets', liveStatus: 'BLOCKED'
  },
  {
    id: 'AZURE_DIAGNOSTIC', lane: 'lane4', goal: 'Azure 読取り専用診断の Workflow を実行可能にする（OIDC/RBAC 未構成は BLOCKED）',
    deps: [], weight: 3, estimatedEffort: 'M', requiredCapabilities: ['github-actions', 'azure-oidc'],
    affectedFiles: ['scripts/azure-readonly-diagnostics.js', '.github/workflows/azure-readonly-diagnostics.yml'],
    evidenceFiles: ['scripts/azure-readonly-diagnostics.js', '.github/workflows/azure-readonly-diagnostics.yml', 'test/azureDiagnosticsWorkflow.test.js'],
    selectiveTests: ['test/azureDiagnosticsWorkflow.test.js'], fullRegressionRequired: false, rollbackAvailable: true,
    humanGate: { reasonCode: 'AZURE_OIDC_RBAC', action: 'GitHub Actions の OIDC 連携（フェデレーション資格情報）と、閲覧用ロールの付与' },
    additionalCost: 'なし', system: 'azure', liveStatus: 'BLOCKED'
  }
]);

const REQUIRED_TASK_IDS = Object.freeze([
  'FILES_ZIP_FACADE', 'ENTRA_READ', 'ENTRA_WRITE', 'POWER_PLATFORM_READ', 'POWER_AUTOMATE_READ', 'POWER_AUTOMATE_WRITE',
  'EMPLOYEE_REGISTRATION_E2E', 'AZURE_DIAGNOSTIC', 'SHAREPOINT_LIVE_READ', 'SHAREPOINT_LIVE_WRITE',
  'PERSISTENT_STORE', 'WEBHOOK_MIGRATION', 'KEY_ROTATION_RUNBOOK'
]);

// 証跡ファイルがすべて存在すればコード上は COMPLETE。依存未達は PENDING、依存達成なら READY。
// 人間操作が必要で未完了のものは BLOCKED、人間の判断で保留するものは DEFERRED にできる。
function codeStatusOf(def, repoRoot, completedIds) {
  const depsOk = def.deps.every((d) => completedIds.has(d));
  const evidenceOk = def.evidenceFiles.every((f) => fs.existsSync(path.join(repoRoot, f)));
  // 証跡があっても、依存が未完了なら COMPLETE にしない（依存順の前提を守る）。
  if (evidenceOk && depsOk) return 'COMPLETE';
  if (def.deferred) return 'DEFERRED';
  // 人間（または実環境の読取り）でしか得られない材料が無いタスクは、依存が揃っていても BLOCKED とする。
  if (def.blockedByHuman && depsOk) return 'BLOCKED';
  return depsOk ? 'READY' : 'PENDING';
}

// 状態を求める。codeStatus と liveStatus は分けて返す。
function evaluateTasks(repoRoot, tasks = REMAINING_TASKS) {
  const completedIds = new Set();
  // 依存順に確定させるため、コード完了の判定を繰り返す（DAGのため数回で収束する）。
  for (let pass = 0; pass < tasks.length; pass += 1) {
    let changed = false;
    for (const def of tasks) {
      if (completedIds.has(def.id)) continue;
      if (codeStatusOf(def, repoRoot, completedIds) === 'COMPLETE') { completedIds.add(def.id); changed = true; }
    }
    if (!changed) break;
  }
  return tasks.map((def) => ({
    id: def.id,
    lane: def.lane,
    goal: def.goal,
    dependencies: def.deps,
    requiredCapabilities: def.requiredCapabilities,
    estimatedEffort: def.estimatedEffort,
    criticalPathWeight: def.weight,
    status: codeStatusOf(def, repoRoot, completedIds),
    liveStatus: def.liveStatus || 'NOT_VERIFIED',
    assignedLane: def.lane,
    affectedFiles: def.affectedFiles,
    selectiveTests: def.selectiveTests,
    fullRegressionRequired: def.fullRegressionRequired,
    rollbackAvailable: def.rollbackAvailable,
    humanGate: def.humanGate,
    additionalCost: def.additionalCost
  }));
}

// クリティカルパス: 未完了タスクだけを対象に、重み付きの最長経路を求める。
function computeCriticalPath(evaluated) {
  const byId = new Map(evaluated.map((t) => [t.id, t]));
  const open = (id) => byId.get(id).status !== 'COMPLETE';
  const memo = new Map();
  const longest = (id) => {
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    let best = { weight: 0, path: [] };
    for (const dep of node.dependencies) {
      if (!open(dep)) continue;
      const sub = longest(dep);
      if (sub.weight > best.weight) best = sub;
    }
    const result = { weight: best.weight + node.criticalPathWeight, path: [...best.path, id] };
    memo.set(id, result);
    return result;
  };
  let top = { weight: 0, path: [] };
  for (const t of evaluated) {
    if (!open(t.id)) continue;
    const r = longest(t.id);
    if (r.weight > top.weight) top = r;
  }
  return top.path;
}

// 完了率。コード完了と実環境検証を別々に出す（実環境の VERIFIED は現時点で 0 件）。
function completionPercent(evaluated) {
  const total = evaluated.reduce((s, t) => s + t.criticalPathWeight, 0);
  const codeDone = evaluated.filter((t) => t.status === 'COMPLETE').reduce((s, t) => s + t.criticalPathWeight, 0);
  const liveDone = evaluated.filter((t) => t.liveStatus === 'VERIFIED').reduce((s, t) => s + t.criticalPathWeight, 0);
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  return { code: pct(codeDone), live: pct(liveDone) };
}

// 人間操作の一括提示（BLOCKED のみ、人間操作ごとに重複排除する対象は呼び出し側で collectBlocked へ渡す）。
function blockedItemsOf(evaluated) {
  return evaluated
    .filter((t) => t.humanGate && (t.liveStatus === 'BLOCKED' || t.status === 'BLOCKED'))
    .map((t) => ({ taskId: t.id, reasonCode: t.humanGate.reasonCode, action: t.humanGate.action, actionKey: t.humanGate.reasonCode }));
}

module.exports = {
  CODE_STATUSES,
  LIVE_STATUSES,
  REMAINING_TASKS,
  REQUIRED_TASK_IDS,
  evaluateTasks,
  computeCriticalPath,
  completionPercent,
  blockedItemsOf
};
