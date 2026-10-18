/**
 * Execution Queue の永続化ストア（ファイル／JSON、追加課金なし）
 *
 * 保存対象: 依頼（Request）、キュー状態、チェックポイント、ステップ状態、承認状態、
 *           冪等キー、実行ロック、監査履歴（Execution History）。
 * - 書き込みは一時ファイルに書いてから rename する（途中で壊れた状態を残さない）。
 * - 読み込みに失敗した場合は例外にして停止する（壊れたファイルを自動で上書きしない）。
 * - 本モジュールは外部ツールに触れない。Memory Store（メモリ上の状態）とは分離し、
 *   ExecutionQueue には save/load のインターフェースだけを見せる。
 */

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const AUDIT_LIMIT = 5000;

function emptyState() {
  return { version: SCHEMA_VERSION, requests: {}, idempotency: {}, locks: {}, audit: [] };
}

class ExecutionStore {
  /**
   * @param {object} options
   * @param {string} options.filePath - 保存先（JSON）
   * @param {() => Date} [options.now]
   */
  constructor({ filePath, now = () => new Date() } = {}) {
    if (!filePath) throw new Error('ExecutionStore: filePath が必要です');
    this.filePath = filePath;
    this.now = now;
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return emptyState();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      throw new Error('実行キューの保存ファイルを読めません（破損の可能性。自動修復せず停止します）');
    }
    if (!parsed || parsed.version !== SCHEMA_VERSION) {
      throw new Error('実行キューの保存形式が未対応です（自動変換せず停止します）');
    }
    return { ...emptyState(), ...parsed };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  listRequests() {
    return Object.values(this.state.requests);
  }

  putRequest(record) {
    this.state.requests[record.id] = record;
    this.save();
  }

  findByIdempotencyKey(key) {
    const id = this.state.idempotency[key];
    return id ? this.state.requests[id] || null : null;
  }

  bindIdempotencyKey(key, requestId) {
    this.state.idempotency[key] = requestId;
    this.save();
  }

  appendAudit(entry) {
    this.state.audit.push({ at: this.now().toISOString(), ...entry });
    if (this.state.audit.length > AUDIT_LIMIT) {
      this.state.audit.splice(0, this.state.audit.length - AUDIT_LIMIT);
    }
    this.save();
  }

  listAudit(requestId) {
    return this.state.audit.filter((entry) => entry.requestId === requestId);
  }

  /** 実行ロックを取得する。期限切れのロックは解除して取り直す。他者の有効なロックがあれば false。 */
  acquireLock(requestId, owner, ttlMs) {
    const nowMs = this.now().getTime();
    const current = this.state.locks[requestId];
    if (current && current.expiresAt > nowMs && current.owner !== owner) return false;
    this.state.locks[requestId] = { owner, expiresAt: nowMs + ttlMs };
    this.save();
    return true;
  }

  releaseLock(requestId, owner) {
    const current = this.state.locks[requestId];
    if (current && current.owner === owner) {
      delete this.state.locks[requestId];
      this.save();
    }
  }

  /** 起動時に、前プロセスが残したロックを全て解除する（単一プロセス前提で、残存ロックは実行中ではない）。 */
  clearLocks() {
    if (Object.keys(this.state.locks).length === 0) return;
    this.state.locks = {};
    this.save();
  }
}

module.exports = { ExecutionStore, SCHEMA_VERSION, AUDIT_LIMIT };
