'use strict';

// 永続ストアの共通アダプター（Lane C）。Azure Table/Blob・SharePoint List など任意の行ストレージへ差し替えられる。
// - 行の保存先は backend（appendRow / listRows）として注入する。このファイルは特定のクラウドSDKに依存しない。
// - 追記専用。更新・物理削除の API は持たない。
// - 保存後に必ず再取得し、保存内容とハッシュ一致を確認する（失敗は STORE_VERIFY_FAILED）。
// - 保存前に秘密値を伏せ字にする（store.js の prepareRecord と同じ規則）。
// - 保存失敗（STORE_WRITE_FAILED）の時は、呼び出し側は変更を開始してはならない。

const { COLLECTIONS, prepareRecord, hashValue } = require('./store');

class DurableStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DurableStoreError';
    this.code = code;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function pick(row, keys) {
  const out = {};
  for (const key of keys) out[key] = row[key];
  return out;
}

function createDurableStore({ backend } = {}) {
  if (!backend || typeof backend.appendRow !== 'function' || typeof backend.listRows !== 'function') {
    throw new Error('backend must provide appendRow and listRows');
  }
  const kind = typeof backend.kind === 'string' ? backend.kind : 'custom';
  const rowsOf = async (collection) => (await backend.listRows(collection)).filter((row) => row.collection === collection).map((row) => row.record);

  return {
    kind,
    durable: true,
    async append(collection, record) {
      const { key, masked } = prepareRecord(collection, record);
      const keyField = COLLECTIONS[collection];
      const existing = await rowsOf(collection);
      if (existing.some((row) => row[keyField] === key)) throw new Error('duplicate key');
      try {
        await backend.appendRow(collection, masked);
      } catch {
        throw new DurableStoreError('STORE_WRITE_FAILED');
      }
      // 保存後再取得: 書き込んだ内容と一致することを確かめてから成功とする。
      const readBack = (await rowsOf(collection)).find((row) => row[keyField] === key);
      if (!readBack || hashValue(pick(readBack, Object.keys(masked))) !== hashValue(masked)) {
        throw new DurableStoreError('STORE_VERIFY_FAILED');
      }
      return clone(masked);
    },
    async get(collection, key) {
      const keyField = COLLECTIONS[collection];
      if (!keyField) throw new Error(`unknown collection: ${collection}`);
      const row = (await rowsOf(collection)).find((item) => item[keyField] === key);
      return row ? clone(row) : null;
    },
    async list(collection) {
      if (!COLLECTIONS[collection]) throw new Error(`unknown collection: ${collection}`);
      return (await rowsOf(collection)).map(clone);
    }
  };
}

// 行ストレージの最小インターフェースを作る。insert/query はクライアントSDKの薄い関数を渡す。
function createRowBackend({ kind, configured = true, insert, query }) {
  if (typeof insert !== 'function' || typeof query !== 'function') throw new Error('insert and query are required');
  return {
    kind,
    configured,
    appendRow: async (collection, record) => insert({ collection, record }),
    listRows: async (collection) => (await query({ collection })) || []
  };
}

// 試験・ローカル用のメモリ行ストレージ。failWrites で保存失敗を再現できる。
function createMemoryRowBackend({ failWrites = () => false, tamperReads = null } = {}) {
  const rows = [];
  return {
    kind: 'memory-row',
    configured: true,
    rows,
    appendRow: async (collection, record) => {
      if (failWrites(collection, record)) throw new Error('simulated write failure');
      rows.push({ collection, record: clone(record) });
    },
    listRows: async (collection) => {
      const out = rows.filter((row) => row.collection === collection).map((row) => ({ collection: row.collection, record: clone(row.record) }));
      return tamperReads ? tamperReads(collection, out) : out;
    }
  };
}

module.exports = { createDurableStore, createRowBackend, createMemoryRowBackend, DurableStoreError };
