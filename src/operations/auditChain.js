'use strict';

// 監査チェーンの整合性検証（Lane C）。
// 各行は prevHash（直前行の recordHash）と recordHash（本体のハッシュ）を持つ。
// 行の改ざん・欠落・並べ替えを検出し、最初に壊れた位置と理由コードを返す。

const { hashValue } = require('./store');

const ZERO_HASH = '0'.repeat(64);

function verifyAuditChain(rows) {
  if (!Array.isArray(rows)) return { ok: false, reasonCode: 'AUDIT_CHAIN_INVALID_INPUT', brokenAt: null, checked: 0 };
  let expectedPrev = ZERO_HASH;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== 'object' || typeof row.recordHash !== 'string') {
      return { ok: false, reasonCode: 'AUDIT_ROW_MALFORMED', brokenAt: index, checked: index };
    }
    const { recordHash, ...body } = row;
    if (hashValue(body) !== recordHash) {
      return { ok: false, reasonCode: 'AUDIT_RECORD_HASH_MISMATCH', brokenAt: index, checked: index };
    }
    if (body.prevHash !== expectedPrev) {
      return { ok: false, reasonCode: 'AUDIT_CHAIN_BROKEN', brokenAt: index, checked: index };
    }
    expectedPrev = recordHash;
  }
  return { ok: true, reasonCode: null, brokenAt: null, checked: rows.length };
}

module.exports = { verifyAuditChain, ZERO_HASH };
