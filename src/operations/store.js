'use strict';

// Clean Nano Operations 用の一時ストレージ抽象。
// - 追記専用（append-only）。物理削除の操作は提供しない。
// - 保存前に秘密値を伏せ字にする（二重の安全策。呼び出し側でも伏せ字にしてからハッシュを計算する）。
// - 本番では同じインターフェースで SharePoint List または Azure Storage に差し替える。
// - append が失敗した場合は例外を投げる。呼び出し側はこれを受けて変更処理を開始してはならない。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { maskDeep } = require('../secretMasking');

const COLLECTIONS = Object.freeze({
  snapshots: 'snapshotId',
  audit: 'auditRecordId'
});

const MAX_RECORD_JSON_LENGTH = 1024 * 1024;

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hashValue(value) {
  return sha256Hex(canonicalJson(value));
}

function assertCollection(collection) {
  if (!Object.prototype.hasOwnProperty.call(COLLECTIONS, collection)) {
    throw new Error(`unknown collection: ${collection}`);
  }
}

function prepareRecord(collection, record) {
  assertCollection(collection);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('record must be an object');
  const masked = maskDeep(JSON.parse(JSON.stringify(record)));
  const json = JSON.stringify(masked);
  if (json.length > MAX_RECORD_JSON_LENGTH) throw new Error('record too large');
  const key = masked[COLLECTIONS[collection]];
  if (typeof key !== 'string' || key.length === 0) throw new Error(`missing key: ${COLLECTIONS[collection]}`);
  return { key, masked };
}

function createMemoryStore() {
  const data = new Map(Object.keys(COLLECTIONS).map((name) => [name, []]));
  return {
    kind: 'memory',
    append(collection, record) {
      const { key, masked } = prepareRecord(collection, record);
      const rows = data.get(collection);
      if (rows.some((row) => row[COLLECTIONS[collection]] === key)) throw new Error('duplicate key');
      rows.push(masked);
      return JSON.parse(JSON.stringify(masked));
    },
    get(collection, key) {
      assertCollection(collection);
      const row = data.get(collection).find((item) => item[COLLECTIONS[collection]] === key);
      return row ? JSON.parse(JSON.stringify(row)) : null;
    },
    list(collection) {
      assertCollection(collection);
      return data.get(collection).map((row) => JSON.parse(JSON.stringify(row)));
    }
  };
}

// JSON Lines 1ファイル。1行 = {collection, record}。追記のみ。
function createFileStore(filePath) {
  const absolute = path.resolve(filePath);
  function readAll() {
    if (!fs.existsSync(absolute)) return [];
    return fs.readFileSync(absolute, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  return {
    kind: 'file',
    append(collection, record) {
      const { masked } = prepareRecord(collection, record);
      const existing = readAll().filter((row) => row.collection === collection);
      if (existing.some((row) => row.record[COLLECTIONS[collection]] === masked[COLLECTIONS[collection]])) {
        throw new Error('duplicate key');
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.appendFileSync(absolute, `${JSON.stringify({ collection, record: masked })}\n`, { encoding: 'utf8', flag: 'a' });
      return JSON.parse(JSON.stringify(masked));
    },
    get(collection, key) {
      assertCollection(collection);
      const row = readAll().find((item) => item.collection === collection && item.record[COLLECTIONS[collection]] === key);
      return row ? JSON.parse(JSON.stringify(row.record)) : null;
    },
    list(collection) {
      assertCollection(collection);
      return readAll().filter((item) => item.collection === collection).map((item) => item.record);
    }
  };
}

function createOperationsStore(options = {}) {
  if (options.filePath) return createFileStore(options.filePath);
  return createMemoryStore();
}

module.exports = {
  COLLECTIONS,
  prepareRecord,
  canonicalJson,
  sha256Hex,
  hashValue,
  createMemoryStore,
  createFileStore,
  createOperationsStore
};
