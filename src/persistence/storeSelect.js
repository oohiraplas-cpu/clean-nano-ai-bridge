'use strict';

// 永続ストアの自動選択（PERSISTENT_STORE）。
// 優先順位は固定: 既存の Azure Storage → 既存の SharePoint 監査リスト → OPERATIONS_STORE_FILE（ファイル）。
// - 利用者にストアを選ばせない。設定と読取り専用の到達性確認だけで決める。
// - 到達性確認（probe）は呼び出し側が注入する。probe は読取り専用であること（書込みしない）。
// - 記録するのは理由コードと到達可否だけ。接続文字列・エンドポイント・値は出力しない。
// - 実環境へ到達できなければ BLOCKED として記録し、ファイルへフォールバックする（フォールバックした事実を残す）。

const { createOperationsStore } = require('../operations/store');

const PRIORITY = Object.freeze(['azure-storage', 'sharepoint-audit-list', 'file']);
const REMOTE = Object.freeze(['azure-storage', 'sharepoint-audit-list']);

// settings: { azureStorage: { configured }, sharePointAudit: { configured }, fileStorePath }
// probes:   { 'azure-storage': async () => ({ reachable, reasonCode? }), 'sharepoint-audit-list': async () => ({...}) }
async function selectPersistentStore({ settings = {}, probes = {} } = {}) {
  const configured = {
    'azure-storage': Boolean(settings.azureStorage?.configured),
    'sharepoint-audit-list': Boolean(settings.sharePointAudit?.configured),
    file: Boolean(settings.fileStorePath)
  };
  const investigation = [];
  let selected = null;

  for (const backend of PRIORITY) {
    if (!configured[backend]) {
      investigation.push({ backend, configured: false, probe: 'NOT_CONFIGURED', reasonCode: 'NOT_CONFIGURED' });
      continue;
    }
    if (backend === 'file') {
      // ファイルは同一プロセス内の保存先。到達性確認は外部接続を伴わない。
      investigation.push({ backend, configured: true, probe: 'LOCAL', reasonCode: null });
      selected = 'file';
      break;
    }
    const probe = probes[backend];
    if (typeof probe !== 'function') {
      investigation.push({ backend, configured: true, probe: 'NOT_PROBED', reasonCode: 'PROBE_NOT_AVAILABLE' });
      continue;
    }
    let result;
    try {
      result = await probe();
    } catch {
      // 例外の内容は記録しない。
      result = { reachable: false, reasonCode: 'PROBE_ERROR' };
    }
    if (result && result.reachable === true) {
      investigation.push({ backend, configured: true, probe: 'REACHABLE', reasonCode: null });
      selected = backend;
      break;
    }
    investigation.push({ backend, configured: true, probe: 'UNREACHABLE', reasonCode: (result && result.reasonCode) || 'UNREACHABLE' });
  }

  if (!selected) {
    return { selected: null, reasonCode: 'NO_STORE_AVAILABLE', fallbackUsed: false, liveStatus: 'BLOCKED', investigation };
  }
  const remoteFailed = investigation.some((i) => REMOTE.includes(i.backend) && i.probe !== 'REACHABLE' && i.configured);
  return {
    selected,
    reasonCode: null,
    // 実環境（リモート）へ到達できた時だけ VERIFIED。ファイル選択やリモート不達は BLOCKED / NOT_VERIFIED として残す。
    fallbackUsed: selected === 'file' && remoteFailed,
    liveStatus: REMOTE.includes(selected) ? 'VERIFIED' : (remoteFailed ? 'BLOCKED' : 'NOT_VERIFIED'),
    investigation
  };
}

// 選択結果に従って、同一の append/get/list 契約を持つストアを返す。
// backends には、リモート各種の契約準拠アダプターを注入する（ファイルは既存の createOperationsStore を使う）。
function createPersistentStore({ selection, backends = {}, fileStorePath } = {}) {
  if (!selection || !selection.selected) throw new Error('no persistent store selected');
  const store = selection.selected === 'file'
    ? createOperationsStore({ filePath: fileStorePath })
    : backends[selection.selected];
  if (!store || typeof store.append !== 'function' || typeof store.get !== 'function' || typeof store.list !== 'function') {
    throw new Error(`backend ${selection.selected} does not satisfy the store contract`);
  }
  return { kind: selection.selected, append: store.append.bind(store), get: store.get.bind(store), list: store.list.bind(store) };
}

module.exports = { selectPersistentStore, createPersistentStore, PRIORITY };
