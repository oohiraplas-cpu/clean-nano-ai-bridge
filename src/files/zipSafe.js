'use strict';

// ZIP の安全な読取・検証・展開・作成（Lane A）。外部ライブラリに依存せず、zlib のみを使う。
// - 検証は展開前に全件行う。1件でも違反があれば展開しない（zip_validate）。
// - 対応: 無圧縮(0) と Deflate(8)。暗号化・ZIP64・分割は拒否する。
// - ZIP Slip（../、絶対パス、ドライブ文字）、シンボリックリンク、重複名、実行可能ファイル、
//   件数・展開後合計・単一ファイル・圧縮率の上限、CRC32 不一致、秘密情報らしき文字列を検出する。
// - 元の ZIP は変更しない（読むだけ）。展開先は既存ファイルを上書きしない。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { checkRelative, PathGuardError, isInside } = require('./pathGuard');
const { containsLikelySecret } = require('../secretMasking');

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const LIMITS_DEFAULT = Object.freeze({
  maxEntries: 500,
  maxTotalUncompressed: 50 * 1024 * 1024,
  maxEntryUncompressed: 10 * 1024 * 1024,
  maxRatio: 100,
  maxNameLength: 255
});
const EXECUTABLE_EXT = /\.(exe|dll|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|sh|bin|app|jar|hta|cpl|reg|lnk)$/i;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class ZipError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'ZipError';
    this.code = code;
    this.detail = detail || null;
  }
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

// 中央ディレクトリを読む。違反は種別コードで返す（例外にはしない）。
function readEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('ZIP_INVALID');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipError('ZIP_INVALID');
  const count = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) throw new ZipError('ZIP64_UNSUPPORTED');
  if (cenOffset + cenSize > buf.length) throw new ZipError('ZIP_INVALID');
  const entries = [];
  let p = cenOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw new ZipError('ZIP_INVALID');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64_UNSUPPORTED');
    entries.push({ name, flags, method, crc, compSize, uncompSize, externalAttrs, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryKind(entry) {
  const mode = (entry.externalAttrs >>> 16) & 0o170000;
  if (mode === 0o120000) return 'symlink';
  if (entry.name.endsWith('/')) return 'directory';
  return 'file';
}

// 1エントリの検証結果（違反コードの配列）。
function checkEntry(entry, limits) {
  const problems = [];
  const name = entry.name;
  try {
    if (name.length > limits.maxNameLength) problems.push('NAME_TOO_LONG');
    if (/\\/.test(name)) problems.push('PATH_BACKSLASH');
    if (name.endsWith('/')) {
      checkRelative(name.slice(0, -1) || '.');
    } else {
      checkRelative(name);
    }
  } catch (error) {
    if (error instanceof PathGuardError) problems.push(error.code === 'PATH_TRAVERSAL' ? 'ZIP_SLIP' : error.code);
    else throw error;
  }
  if (entry.flags & 0x1) problems.push('ENCRYPTED');
  if (entry.method !== 0 && entry.method !== 8) problems.push('METHOD_UNSUPPORTED');
  if (entryKind(entry) === 'symlink') problems.push('SYMLINK');
  if (entryKind(entry) === 'file' && EXECUTABLE_EXT.test(name)) problems.push('EXECUTABLE_ENTRY');
  if (entry.uncompSize > limits.maxEntryUncompressed) problems.push('ENTRY_TOO_LARGE');
  if (entry.compSize > 0 && entry.uncompSize / entry.compSize > limits.maxRatio) problems.push('COMPRESSION_RATIO_EXCEEDED');
  if (entry.compSize === 0 && entry.uncompSize > 0) problems.push('COMPRESSION_RATIO_EXCEEDED');
  return problems;
}

// 検証（展開しない）。全エントリを見て、違反の一覧を返す。
function validateZip(buf, options = {}) {
  const limits = { ...LIMITS_DEFAULT, ...options };
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  let entries;
  try {
    entries = readEntries(buf);
  } catch (error) {
    return { ok: false, sha256, reasonCode: error.code || 'ZIP_INVALID', violations: [], entries: [] };
  }
  const violations = [];
  if (entries.length > limits.maxEntries) violations.push({ name: null, code: 'TOO_MANY_ENTRIES' });
  let total = 0;
  const seen = new Set();
  for (const entry of entries) {
    for (const code of checkEntry(entry, limits)) violations.push({ name: entry.name, code });
    if (seen.has(entry.name)) violations.push({ name: entry.name, code: 'DUPLICATE_NAME' });
    seen.add(entry.name);
    total += entry.uncompSize;
  }
  if (total > limits.maxTotalUncompressed) violations.push({ name: null, code: 'TOTAL_SIZE_EXCEEDED' });
  const summary = entries.map((e) => ({ name: e.name, kind: entryKind(e), uncompressedSize: e.uncompSize, method: e.method }));
  return {
    ok: violations.length === 0,
    sha256,
    reasonCode: violations.length === 0 ? null : violations[0].code,
    totalUncompressedSize: total,
    entryCount: entries.length,
    violations,
    entries: summary
  };
}

// 1エントリを読み出す（CRC と展開サイズを確認）。
function readEntryData(buf, entry, limits) {
  const loc = entry.localOffset;
  if (loc + 30 > buf.length || buf.readUInt32LE(loc) !== SIG_LOC) throw new ZipError('ZIP_INVALID');
  const nameLen = buf.readUInt16LE(loc + 26);
  const extraLen = buf.readUInt16LE(loc + 28);
  const start = loc + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (raw.length !== entry.compSize) throw new ZipError('ZIP_INVALID');
  let data;
  try {
    data = entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: limits.maxEntryUncompressed + 1 }) : Buffer.from(raw);
  } catch {
    throw new ZipError('DECOMPRESS_FAILED');
  }
  if (data.length > limits.maxEntryUncompressed) throw new ZipError('ENTRY_TOO_LARGE');
  if (data.length !== entry.uncompSize) throw new ZipError('SIZE_MISMATCH');
  if (crc32(data) !== entry.crc) throw new ZipError('CRC_MISMATCH');
  return data;
}

// 展開: 検証が全件 OK のときだけ行う。既存ファイルは上書きしない。
function extractZip(buf, destDir, options = {}) {
  const limits = { ...LIMITS_DEFAULT, ...options };
  const report = validateZip(buf, limits);
  if (!report.ok) return { ok: false, reasonCode: report.reasonCode, violations: report.violations, extracted: [], sha256: report.sha256 };
  const entries = readEntries(buf);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const plan = [];
  for (const entry of entries) {
    const kind = entryKind(entry);
    if (kind === 'directory') continue;
    const rel = checkRelative(entry.name);
    const target = path.resolve(realRoot, rel);
    if (!isInside(realRoot, target)) return { ok: false, reasonCode: 'ZIP_SLIP', violations: [{ name: entry.name, code: 'ZIP_SLIP' }], extracted: [], sha256: report.sha256 };
    if (fs.existsSync(target)) return { ok: false, reasonCode: 'TARGET_EXISTS', violations: [{ name: entry.name, code: 'TARGET_EXISTS' }], extracted: [], sha256: report.sha256 };
    plan.push({ entry, target, rel });
  }
  const extracted = [];
  for (const { entry, target, rel } of plan) {
    let data;
    try { data = readEntryData(buf, entry, limits); } catch (error) {
      return { ok: false, reasonCode: error.code || 'ZIP_INVALID', violations: [{ name: entry.name, code: error.code }], extracted, sha256: report.sha256 };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
    extracted.push({ path: rel.split(path.sep).join('/'), size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  }
  return { ok: true, reasonCode: null, violations: [], extracted, sha256: report.sha256 };
}

// 展開せずに中身の秘密情報らしき文字列を確認する（テキストとして読めるものだけ）。
function scanZipForSecrets(buf, options = {}) {
  const limits = { ...LIMITS_DEFAULT, ...options };
  const entries = readEntries(buf);
  const findings = [];
  for (const entry of entries) {
    if (entryKind(entry) !== 'file' || checkEntry(entry, limits).length > 0) continue;
    let data;
    try { data = readEntryData(buf, entry, limits); } catch { continue; }
    const text = data.toString('utf8');
    if (!text.includes('\u0000') && containsLikelySecret(text)) findings.push({ name: entry.name });
  }
  return { findings: findings.length, names: findings.map((f) => f.name) };
}

// 作成: 通常のファイル群から ZIP を作る。ディレクトリ区切りは / に統一する。
function createZip(files, { method = 8 } = {}) {
  if (method !== 0 && method !== 8) throw new ZipError('METHOD_UNSUPPORTED');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(checkRelativeOrThrow(file.name), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const block = Buffer.concat([local, name, comp]);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE((file.unixMode ?? 0o100644) << 16 >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cen, name]));
    locals.push(block);
    offset += block.length;
  }
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

function checkRelativeOrThrow(name) {
  checkRelative(name);
  return name;
}

module.exports = { validateZip, extractZip, scanZipForSecrets, createZip, readEntries, crc32, ZipError, LIMITS_DEFAULT, EXECUTABLE_EXT };
