'use strict';

// Power Automate 書込み（POWER_AUTOMATE_WRITE）の承認ゲート付きラッパー。
// - 実処理は既存の powerAutomateFlowWriter（snapshot → 編集 → 検証 → 再取得照合 → rollback）を使う。
// - 本ラッパーは、実行（dryRun 以外）の前に approvedByHuman === true を要求する。無ければ書込みを呼ばず拒否する。
// - クライアントと snapshot 保存先は注入必須。既定値（環境変数）へのフォールバックはしない（誤って実環境へ書かないため）。
// - 状態変更（on/off）は既存の writer に snapshot が無いため、前の状態を取得して rollback 情報として返す。
// - 戻り値には rollback の method と args を含める（Entra 書込みと同じ形）。

const writer = require('../powerAutomateFlowWriter');

const OPERATIONS = Object.freeze(['flow_update', 'flow_set_state', 'flow_restore']);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function requireInjected(deps) {
  if (!deps || !deps.client || typeof deps.client.get !== 'function' || typeof deps.client.patch !== 'function') {
    throw fail('CLIENT_NOT_INJECTED', 'Dataverse クライアントの注入が必要です（既定の接続は使わない）');
  }
  if (typeof deps.snapshotDir !== 'string' || deps.snapshotDir.length === 0) {
    throw fail('SNAPSHOT_DIR_REQUIRED', 'snapshot 保存先の明示が必要です');
  }
  return { client: deps.client, snapshotDir: deps.snapshotDir };
}

async function currentState(client, flowId) {
  const w = await client.get(`workflows(${flowId})?$select=statecode,statuscode`);
  return { state: w.statecode === 1 ? 'on' : 'off', statuscode: w.statuscode ?? null };
}

// operation: 'flow_update' | 'flow_set_state' | 'flow_restore'
// args: flow_update { flowId, edits, dryRun? }, flow_set_state { flowId, state }, flow_restore { snapshotId }
async function runPowerAutomateWrite({ operation, args = {}, approvedByHuman = false } = {}, deps = {}) {
  if (!OPERATIONS.includes(operation)) throw fail('UNSUPPORTED_OPERATION', 'unsupported Power Automate write operation');
  const { client, snapshotDir } = requireInjected(deps);
  const dryRun = operation === 'flow_update' && args.dryRun === true;

  // 実行系（dry-run 以外）は、人間の承認が無ければ一切書かない。
  if (!dryRun && approvedByHuman !== true) {
    return { status: 'APPROVAL_REQUIRED', operation, executed: false };
  }

  const inner = { ...deps, client, snapshotDir };

  if (operation === 'flow_update') {
    const result = await writer.updateFlow({ flowId: args.flowId, edits: args.edits, dryRun }, inner);
    return {
      status: result.status,
      operation,
      executed: !dryRun,
      snapshotId: result.snapshotId,
      verified: result.status === 'saved_verified',
      dryRun,
      rollback: dryRun ? null : { method: 'flow_restore', args: { snapshotId: result.snapshotId } }
    };
  }

  if (operation === 'flow_set_state') {
    const flowId = String(args.flowId || '').toLowerCase();
    const before = await currentState(client, flowId);
    const result = await writer.setFlowState({ flowId, state: args.state }, inner);
    return {
      status: result.status,
      operation,
      executed: true,
      verified: result.status === 'verified',
      before: before.state,
      after: result.state,
      rollback: { method: 'flow_set_state', args: { flowId, state: before.state } }
    };
  }

  // flow_restore
  const result = await writer.rollbackFlow({ snapshotId: args.snapshotId }, inner);
  return { status: result.status, operation, executed: true, verified: result.verified === true, rollback: null };
}

module.exports = { runPowerAutomateWrite, OPERATIONS };
